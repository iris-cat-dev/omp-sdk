#![cfg(unix)]

use std::{path::Path, sync::Arc, time::Duration};

use pi_shell::{
	Shell, ShellRunOptions,
	bash::trace::{RunTrace, history::HistoryData},
	cancel::CancelToken,
	proctree::{Process, ProcessStatus},
};
use tokio::time;

fn quoted(path: &Path) -> String {
	format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
}

async fn run(shell: &Shell, command: String) -> String {
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(ShellRunOptions { command, ..Default::default() }, Some(tx), CancelToken::default())
		.await
		.expect("run real embedded shell");
	assert_eq!(result.exit_code, Some(0));
	rx.try_iter().collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_stop_reaps_idle_nohup_and_internal_jobs_without_losing_session_state() {
	let dir = tempfile::tempdir().unwrap();
	let cwd = dir.path().canonicalize().unwrap();
	let leaked = dir.path().join("after-stop");
	let shell = Shell::new(None);
	let pid = run(
		&shell,
		format!(
			"export STOP_KEPT=kept; stop_fn() {{ printf 'function\\n'; }}; alias stop_alias='printf \
			 \"alias\\n\"'; shopt -s expand_aliases; cd {}; nohup /bin/sh -c 'sleep 60' >/dev/null \
			 2>&1 & printf '%s\\n' \"$!\"",
			quoted(&cwd),
		),
	)
	.await
	.trim()
	.parse::<i32>()
	.expect("nohup exposes its real external child pid");
	let child = Process::from_pid(pid).expect("owned background child is alive");
	assert_eq!(child.status(), ProcessStatus::Running);
	run(&shell, format!("(sleep 1; printf leaked > {}) >/dev/null 2>&1 &", quoted(&leaked))).await;
	assert!(shell.live_background_job_count().await > 0);
	time::timeout(Duration::from_secs(10), shell.abort())
		.await
		.expect("Stop converges")
		.expect("Stop drains owned resources");
	assert_ne!(child.status(), ProcessStatus::Running);
	assert_eq!(shell.live_background_job_count().await, 0);
	let resumed =
		run(&shell, "stop_fn; stop_alias; printf '%s\\n%s\\n' \"$STOP_KEPT\" \"$PWD\"".into()).await;
	assert_eq!(resumed, format!("function\nalias\nkept\n{}\n", cwd.display()));
	time::sleep(Duration::from_millis(1100)).await;
	assert!(!leaked.exists(), "an internal background job resumed after Stop resolved");
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_stop_returns_a_settled_trace_and_preserves_the_next_run() {
	assert_cancelled_trace("printf 'started\\n'; /bin/sleep 60").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn explicit_stop_closes_nested_function_and_loop_commands() {
	assert_cancelled_trace(
		"stop_wait() { while true; do printf 'started\\n'; /bin/sleep 60; done; }; stop_wait",
	)
	.await;
}

async fn assert_cancelled_trace(command: &'static str) {
	let shell = Arc::new(Shell::new(None));
	let trace = Arc::new(RunTrace::new(command));
	let pending = tokio::spawn({
		let shell = Arc::clone(&shell);
		let trace = Arc::clone(&trace);
		async move {
			shell
				.run(
					ShellRunOptions {
						command: command.into(),
						trace: Some(trace),
						..Default::default()
					},
					None,
					CancelToken::default(),
				)
				.await
		}
	});
	time::timeout(Duration::from_secs(5), async {
		loop {
			let snapshot = trace.snapshot();
			let output: Vec<u8> = snapshot
				.history
				.iter()
				.filter_map(|entry| match &entry.data {
					HistoryData::Output { text, .. } => Some(text.as_slice()),
					_ => None,
				})
				.flatten()
				.copied()
				.collect();
			if !shell.pids().is_empty() && output == b"started\n" {
				break;
			}
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("external command starts and its predecessor's output is captured");
	let live = trace.snapshot();
	assert!(
		live
			.history
			.iter()
			.any(|entry| matches!(entry.data, HistoryData::CmdStart))
	);
	assert!(
		live
			.history
			.iter()
			.any(|entry| matches!(entry.data, HistoryData::Output { .. }))
	);
	let sleep_tag = live
		.history
		.iter()
		.find_map(|entry| match &entry.data {
			HistoryData::CmdExpanded { argv, .. }
				if argv
					.first()
					.is_some_and(|word| word.as_slice() == b"/bin/sleep") =>
			{
				entry.command
			},
			_ => None,
		})
		.expect("running external command has its real execution identity");

	time::timeout(Duration::from_secs(10), shell.abort())
		.await
		.unwrap()
		.unwrap();
	let result = pending.await.unwrap().unwrap();
	assert!(result.cancelled);
	assert!(shell.pids().is_empty());
	let final_snapshot = trace.snapshot();
	assert!(final_snapshot.status.is_some_and(|status| status != 0));
	assert!(
		final_snapshot
			.history
			.iter()
			.any(|entry| matches!(entry.data, HistoryData::RunEnd { status } if status != 0))
	);
	let command_end = final_snapshot
		.history
		.iter()
		.position(|entry| {
			entry.command == Some(sleep_tag)
				&& matches!(entry.data, HistoryData::CmdEnd { status, .. } if status != 0)
		})
		.expect("cancelled external command emits its own CmdEnd");
	let run_end = final_snapshot
		.history
		.iter()
		.position(|entry| {
			entry.vpid == final_snapshot.root_vpid && matches!(entry.data, HistoryData::RunEnd { .. })
		})
		.expect("the real root RunEnd is retained");
	assert!(command_end < run_end, "active command ends before its real run ends");
	let version = trace.version();
	let json = trace.snapshot_json();
	let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
	for unit in parsed["units"].as_array().unwrap() {
		for node in unit["nodes"].as_array().unwrap() {
			assert_ne!(node["state"].as_str(), Some("running"));
		}
	}
	assert_eq!(run(&shell, "printf next".into()).await, "next");
	time::sleep(Duration::from_millis(50)).await;
	assert_eq!(trace.version(), version);
	assert_eq!(trace.snapshot_json(), json, "completed capture cannot change the cancelled run");
}
