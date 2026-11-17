//! Strict, occurrence-oriented filesystem search on the shared walker/scanner.

use std::{
	path::Path,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
};

use futures::StreamExt;
use grep_regex::RegexMatcher;
use tokio::sync::mpsc;

use super::{GrepError, scan::FileScanner};
use crate::{
	fs::{Dir, FileType, Fs, Session},
	glob::Overrides,
	walk::{self, Action, Entry, Worker},
};

/// One non-overlapping occurrence, measured in original-line UTF-16 units.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSearchRange {
	pub start:  u64,
	pub length: u64,
}

/// A matching source line, with every occurrence found by the native matcher.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSearchMatch {
	pub path:        String,
	pub line_number: u64,
	pub line:        String,
	pub ranges:      Vec<FileSearchRange>,
}

/// Filesystem search settings. The matcher is compiled exactly once by the
/// caller.
pub struct FileSearchOptions {
	pub matcher:       Arc<RegexMatcher>,
	pub include_globs: Vec<String>,
	pub exclude_globs: Vec<String>,
	pub max_matches:   Option<u64>,
	pub sink:          Option<mpsc::Sender<Vec<FileSearchMatch>>>,
}

/// Complete occurrence and file counts, or the counts up to `max_matches`.
#[derive(Default, Debug, PartialEq, Eq)]
pub struct FileSearchResult {
	pub matches:            Vec<FileSearchMatch>,
	pub total_matches:      u64,
	pub files_with_matches: u64,
	pub files_searched:     u64,
	pub limit_reached:      bool,
}

/// Shared occurrence budget. Reservation happens before allocating a range.
pub(super) struct FileSearchControl {
	pub halt:  AtomicBool,
	remaining: Option<AtomicU64>,
}

impl FileSearchControl {
	pub fn stopped(&self) -> bool {
		self.halt.load(Ordering::Relaxed) || self.exhausted()
	}

	pub fn exhausted(&self) -> bool {
		self
			.remaining
			.as_ref()
			.is_some_and(|left| left.load(Ordering::Relaxed) == 0)
	}

	pub fn reserve(&self) -> bool {
		if self.halt.load(Ordering::Relaxed) {
			return false;
		}
		self.remaining.as_ref().is_none_or(|left| {
			left
				.try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_sub(1))
				.is_ok()
		})
	}
}

struct HaltOnDrop(Arc<FileSearchControl>);
impl Drop for HaltOnDrop {
	fn drop(&mut self) {
		self.0.halt.store(true, Ordering::Relaxed);
	}
}

struct FileSearchSink {
	matcher: Arc<RegexMatcher>,
	control: Arc<FileSearchControl>,
	sink:    Option<mpsc::Sender<Vec<FileSearchMatch>>>,
}

impl walk::Sink for FileSearchSink {
	type Item = Vec<u8>;
	type Out = Result<FileSearchResult, GrepError>;
	type State = FileScanner;

	const COLLECTS: bool = false;
	const KEEPS_DIR: bool = false;

	fn state(&self) -> FileScanner {
		FileScanner::default()
	}

	fn visit(&self, _: &mut Worker<'_>, entry: &mut Entry<'_>, out: &mut Vec<Vec<u8>>) -> Action {
		if self.control.stopped() {
			return Action::Stop;
		}
		if entry.file_type == FileType::File {
			out.push(entry.path.to_vec());
		}
		Action::Continue
	}

	async fn settle(
		&self,
		scanner: &mut FileScanner,
		session: &mut Session,
		worker: &mut Worker<'_>,
		dir: Option<&Dir>,
		items: Vec<Vec<u8>>,
	) -> Vec<Self::Out> {
		let mut result = FileSearchResult::default();
		for rel in items {
			if self.control.stopped() {
				break;
			}
			let opened = match dir {
				Some(dir) => {
					session
						.open_file_at(dir, rel.rsplit(|&b| b == b'/').next().unwrap_or(&rel))
						.await
				},
				None => session.open_file(worker.abs_rel(&rel)).await,
			};
			let (mut file, _) = match opened {
				Ok(opened) => opened,
				Err(error) => {
					return vec![Err(GrepError::Search(format!(
						"{}: {error}",
						String::from_utf8_lossy(&rel)
					)))];
				},
			};
			let path = String::from_utf8_lossy(&rel);
			match scanner
				.search(
					self.matcher.as_ref(),
					&mut file,
					&path,
					&self.control,
					self.sink.as_ref(),
					&mut result.matches,
				)
				.await
			{
				Ok(count) => {
					result.files_searched += 1;
					result.total_matches += count;
					result.files_with_matches += u64::from(count > 0);
				},
				Err(err) => return vec![Err(err)],
			}
		}
		vec![Ok(result)]
	}
}

/// Searches complete files with ripgrep's default hidden/ignore/glob policy.
/// Dropping this future cancels the shared walker and every scanner.
pub async fn search_files(
	fs: &Fs,
	root: &Path,
	options: FileSearchOptions,
) -> Result<FileSearchResult, GrepError> {
	let overrides =
		Overrides::new(&options.include_globs, &options.exclude_globs).map_err(GrepError::Glob)?;
	let control = Arc::new(FileSearchControl {
		halt:      AtomicBool::new(false),
		remaining: options.max_matches.map(AtomicU64::new),
	});
	let _halt = HaltOnDrop(Arc::clone(&control));
	if control.exhausted() {
		return Ok(FileSearchResult { limit_reached: true, ..Default::default() });
	}
	let mut session = fs.session();
	let info = session
		.stat(root, true)
		.await
		.map_err(GrepError::NotFound)?;
	if info.file_type == Some(FileType::File) {
		let (mut file, _) = session
			.open_file(root)
			.await
			.map_err(|err| GrepError::Search(err.to_string()))?;
		let mut result = FileSearchResult::default();
		let count = FileScanner::default()
			.search(
				options.matcher.as_ref(),
				&mut file,
				&root.to_string_lossy(),
				&control,
				options.sink.as_ref(),
				&mut result.matches,
			)
			.await?;
		result.files_searched = 1;
		result.files_with_matches = u64::from(count > 0);
		result.total_matches = count;
		result.limit_reached = control.exhausted();
		return Ok(result);
	}
	drop(session);
	let opts = walk::Options {
		hidden: false,
		gitignore: true,
		require_git: true,
		overrides: Some(Arc::new(overrides)),
		..Default::default()
	};
	let streamed = options.sink.is_some();
	let mut walked = walk::walk_sink(fs, root, &opts, FileSearchSink {
		matcher: options.matcher,
		control: Arc::clone(&control),
		sink:    options.sink,
	})
	.await
	.map_err(GrepError::Walk)?;
	let mut result = FileSearchResult::default();
	while let Some(batch) = walked.next().await {
		for found in batch.items {
			let found = found?;
			result.total_matches += found.total_matches;
			result.files_with_matches += found.files_with_matches;
			result.files_searched += found.files_searched;
			result.matches.extend(found.matches);
		}
	}
	if let Some(error) = walked.into_errors().into_iter().next() {
		return Err(GrepError::Search(format!("{}: {}", error.path.display(), error.error)));
	}
	result.limit_reached = control.exhausted();
	if !streamed {
		result
			.matches
			.sort_unstable_by(|a, b| (&a.path, a.line_number).cmp(&(&b.path, b.line_number)));
	}
	Ok(result)
}
