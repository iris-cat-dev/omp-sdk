//! Model-capability file namespace. No pathname operation is relative to ambient cwd.
//! Each component is opened relative to a pinned directory descriptor with NOFOLLOW.
use napi::{bindgen_prelude::Buffer, Error, Result};
use napi_derive::napi;

fn denied() -> Error { Error::from_reason("Sandbox file access denied") }

#[napi(object)]
pub struct SandboxStat { pub is_directory: bool, pub size: f64, pub modified_at: f64 }
#[napi(object)]
pub struct SandboxEntry { pub name: String, pub is_directory: bool, pub size: f64, pub modified_at: f64 }

#[cfg(unix)]
mod posix {
	use super::*;
	use std::{ffi::{CStr, CString}, fs::File, io::{Read, Write}, os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd}};
	const MAX_BYTES: usize = 200 * 1024 * 1024;
	const MAX_ENTRIES: usize = 1024;
	fn name(value: &str) -> Result<CString> { CString::new(value).map_err(|_| denied()) }
	fn parts(value: &str, directory: bool) -> Result<Vec<&str>> {
		if directory && (value == "." || value.is_empty()) { return Ok(Vec::new()); }
		if value.is_empty() || value.starts_with('/') || value.contains(['\\', ':', '\0']) { return Err(denied()); }
		let parts: Vec<_> = value.split('/').collect();
		if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") { return Err(denied()); }
		Ok(parts)
	}
	fn open_at(fd: RawFd, part: &str, flags: i32, mode: libc::mode_t) -> Result<OwnedFd> {
		let part = name(part)?;
		// SAFETY: valid C string and descriptor; ownership is adopted only on success.
		let fd = unsafe { libc::openat(fd, part.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK, mode as libc::c_uint) };
		if fd < 0 { return Err(denied()); }
		Ok(unsafe { OwnedFd::from_raw_fd(fd) })
	}
	fn stat(fd: RawFd) -> Result<libc::stat> {
		let mut out = std::mem::MaybeUninit::uninit();
		if unsafe { libc::fstat(fd, out.as_mut_ptr()) } != 0 { return Err(denied()); }
		Ok(unsafe { out.assume_init() })
	}
	fn regular(fd: RawFd) -> Result<libc::stat> {
		let st = stat(fd)?;
		if st.st_mode & libc::S_IFMT != libc::S_IFREG || st.st_nlink != 1 { return Err(denied()); }
		Ok(st)
	}
	pub struct Root(pub OwnedFd, pub usize);
	impl Root {
		pub fn open(root: &str, max_bytes: u32) -> Result<Self> {
			if max_bytes == 0 || max_bytes as usize > MAX_BYTES { return Err(denied()); }
			if !root.starts_with('/') || root == "/" { return Err(denied()); }
			let slash = name("/")?;
			let raw = unsafe { libc::open(slash.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
			if raw < 0 { return Err(denied()); }
			let mut fd = unsafe { OwnedFd::from_raw_fd(raw) };
			for component in parts(&root[1..], false)? { fd = open_at(fd.as_raw_fd(), component, libc::O_RDONLY | libc::O_DIRECTORY, 0)?; }
			Ok(Self(fd, max_bytes as usize))
		}
		fn directory(&self, components: &[&str]) -> Result<OwnedFd> {
			let mut fd = open_at(self.0.as_raw_fd(), ".", libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
			for component in components { fd = open_at(fd.as_raw_fd(), component, libc::O_RDONLY | libc::O_DIRECTORY, 0)?; }
			Ok(fd)
		}
		pub fn read(&self, path: &str, limit: Option<u32>) -> Result<Buffer> {
			let limit = limit.map_or(self.1, |value| value as usize);
			if limit == 0 || limit > self.1 { return Err(denied()); }
			let components = parts(path, false)?;
			let parent = self.directory(&components[..components.len()-1])?;
			let fd = open_at(parent.as_raw_fd(), components[components.len()-1], libc::O_RDONLY, 0)?;
			let st = regular(fd.as_raw_fd())?;
			if st.st_size > limit as i64 { return Err(denied()); }
			let mut file = File::from(fd);
			let mut bytes = Vec::with_capacity(st.st_size as usize);
			Read::by_ref(&mut file).take((limit + 1) as u64).read_to_end(&mut bytes).map_err(|_| denied())?;
			regular(file.as_raw_fd())?;
			if bytes.len() > limit { return Err(denied()); }
			Ok(bytes.into())
		}
		pub fn list(&self, path: &str) -> Result<Vec<SandboxEntry>> {
			let fd = self.directory(&parts(path, true)?)?;
			// fdopendir adopts the fd; the guard closes it even on invalid names/limits.
			use std::os::fd::IntoRawFd;
			let raw = fd.into_raw_fd();
			let dir = unsafe { libc::fdopendir(raw) };
			if dir.is_null() { unsafe { libc::close(raw); } return Err(denied()); }
			struct Dir(*mut libc::DIR);
			impl Drop for Dir { fn drop(&mut self) { unsafe { libc::closedir(self.0); } } }
			let dir = Dir(dir);
			let mut entries = Vec::new();
			loop {
				errno::set_errno(errno::Errno(0));
				let entry = unsafe { libc::readdir(dir.0) };
				if entry.is_null() {
					if errno::errno().0 != 0 { return Err(denied()); }
					break;
				}
				let value = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_str().map_err(|_| denied())?;
				if value == "." || value == ".." { continue; }
				parts(value, false)?;
				let entry_fd = open_at(raw, value, libc::O_RDONLY, 0)?;
				let st = stat(entry_fd.as_raw_fd())?;
				let is_directory = st.st_mode & libc::S_IFMT == libc::S_IFDIR;
				if !is_directory { regular(entry_fd.as_raw_fd())?; }
				entries.push(SandboxEntry { name: value.to_owned(), is_directory, size: st.st_size as f64, modified_at: st.st_mtime as f64 * 1000.0 });
				if entries.len() > MAX_ENTRIES { return Err(denied()); }
			}
			entries.sort_by(|a, b| a.name.cmp(&b.name));
			Ok(entries)
		}
		pub fn write(&self, path: &str, bytes: &[u8], exclusive: bool) -> Result<()> {
			if bytes.len() > self.1 { return Err(denied()); }
			let components = parts(path, false)?;
			let parent = self.directory(&components[..components.len()-1])?;
			let target = name(components[components.len()-1])?;
			let mut target_stat = std::mem::MaybeUninit::<libc::stat>::uninit();
			let status = unsafe { libc::fstatat(parent.as_raw_fd(), target.as_ptr(), target_stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
			if status == 0 {
				if exclusive { return Err(denied()); }
				let st = unsafe { target_stat.assume_init() };
				if st.st_mode & libc::S_IFMT != libc::S_IFREG || st.st_nlink != 1 { return Err(denied()); }
			} else if std::io::Error::last_os_error().raw_os_error() != Some(libc::ENOENT) { return Err(denied()); }
			// A new inode + rename never truncates the pre-existing inode, including
			// a hardlink installed after validation. All mutations use the pinned parent.
			let mut nonce = [0_u8; 16];
			getrandom::fill(&mut nonce).map_err(|_| denied())?;
			let temp = format!(".sandbox-write-{:032x}", u128::from_ne_bytes(nonce));
			let fd = open_at(parent.as_raw_fd(), &temp, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o600)?;
			let temp = name(&temp)?;
			struct Temp<'a> { parent: RawFd, name: &'a CStr }
			impl Drop for Temp<'_> { fn drop(&mut self) { unsafe { libc::unlinkat(self.parent, self.name.as_ptr(), 0); } } }
			let _cleanup = Temp { parent: parent.as_raw_fd(), name: &temp };
			let mut file = File::from(fd);
			file.write_all(bytes).map_err(|_| denied())?;
			file.sync_all().map_err(|_| denied())?;
			regular(file.as_raw_fd())?;
			if exclusive {
				// linkat provides atomic no-replace publication; source is our fresh inode.
				if unsafe { libc::linkat(parent.as_raw_fd(), temp.as_ptr(), parent.as_raw_fd(), target.as_ptr(), 0) } != 0 { return Err(denied()); }
			} else if unsafe { libc::renameat(parent.as_raw_fd(), temp.as_ptr(), parent.as_raw_fd(), target.as_ptr()) } != 0 { return Err(denied()); }
			Ok(())
		}
		pub fn metadata(&self, path: &str) -> Result<SandboxStat> {
			let components = parts(path, true)?;
			let fd = if components.is_empty() { self.directory(&[])? } else {
				let parent = self.directory(&components[..components.len()-1])?;
				open_at(parent.as_raw_fd(), components[components.len()-1], libc::O_RDONLY, 0)?
			};
			let st = stat(fd.as_raw_fd())?;
			let is_directory = st.st_mode & libc::S_IFMT == libc::S_IFDIR;
			if !is_directory { regular(fd.as_raw_fd())?; }
			Ok(SandboxStat { is_directory, size: st.st_size as f64, modified_at: st.st_mtime as f64 * 1000.0 })
		}
		pub fn mkdir(&self, path: &str) -> Result<()> {
			let components = parts(path, false)?;
			let mut fd = self.directory(&[])?;
			for component in components {
				let component_name = name(component)?;
				if unsafe { libc::mkdirat(fd.as_raw_fd(), component_name.as_ptr(), 0o700) } != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) { return Err(denied()); }
				fd = open_at(fd.as_raw_fd(), component, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
			}
			Ok(())
		}
		pub fn remove(&self, path: &str) -> Result<()> {
			let components = parts(path, false)?;
			let parent = self.directory(&components[..components.len()-1])?;
			let leaf = components[components.len()-1];
			let fd = open_at(parent.as_raw_fd(), leaf, libc::O_RDONLY, 0)?;
			regular(fd.as_raw_fd())?;
			let leaf = name(leaf)?;
			if unsafe { libc::unlinkat(parent.as_raw_fd(), leaf.as_ptr(), 0) } != 0 { return Err(denied()); }
			Ok(())
		}
	}
}

/// Pinned, bounded file namespace; unsupported platforms fail closed.
#[napi]
pub struct SandboxFs {
	#[cfg(unix)]
	root: Option<posix::Root>,
}
#[napi]
impl SandboxFs {
	#[napi(constructor)]
	pub fn new(root: String, max_bytes: Option<u32>) -> Result<Self> {
		#[cfg(unix)] { Ok(Self { root: Some(posix::Root::open(&root, max_bytes.unwrap_or(1024 * 1024))?) }) }
		#[cfg(not(unix))] { let _ = (root, max_bytes); Err(denied()) }
	}
	#[napi]
	pub fn read(&self, path: String, max_bytes: Option<u32>) -> Result<Buffer> {
		#[cfg(unix)] { self.root.as_ref().ok_or_else(denied)?.read(&path, max_bytes) }
		#[cfg(not(unix))] { let _ = (path, max_bytes); Err(denied()) }
	}
	#[napi]
	pub fn list(&self, path: String) -> Result<Vec<SandboxEntry>> {
		#[cfg(unix)] { self.root.as_ref().ok_or_else(denied)?.list(&path) }
		#[cfg(not(unix))] { let _ = path; Err(denied()) }
	}
	#[napi]
	pub fn write(&self, path: String, content: Buffer, exclusive: Option<bool>) -> Result<()> {
		#[cfg(unix)] { self.root.as_ref().ok_or_else(denied)?.write(&path, &content, exclusive.unwrap_or(false)) }
		#[cfg(not(unix))] { let _ = (path, content, exclusive); Err(denied()) }
	}
	#[napi]
	pub fn stat(&self, path: String) -> Result<SandboxStat> {
		#[cfg(unix)] { self.root.as_ref().ok_or_else(denied)?.metadata(&path) }
		#[cfg(not(unix))] { let _ = path; Err(denied()) }
	}
	#[napi]
	pub fn mkdir(&self, path: String) -> Result<()> {
		#[cfg(unix)] { self.root.as_ref().ok_or_else(denied)?.mkdir(&path) }
		#[cfg(not(unix))] { let _ = path; Err(denied()) }
	}
	#[napi]
	pub fn remove(&self, path: String) -> Result<()> {
		#[cfg(unix)] { self.root.as_ref().ok_or_else(denied)?.remove(&path) }
		#[cfg(not(unix))] { let _ = path; Err(denied()) }
	}
	#[napi]
	pub fn close(&mut self) {
		#[cfg(unix)] { self.root = None; }
	}
}
