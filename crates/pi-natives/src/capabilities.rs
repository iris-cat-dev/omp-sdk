//! Report compiled capability boundaries independently of package version.

use napi_derive::napi;

/// Optional engines present in this native addon.
#[napi(object)]
pub struct NativeCapabilities {
	pub smollm:              bool,
	pub live_voice:          bool,
	pub wasm_grammars:       bool,
	pub pdf:                 bool,
	pub jujutsu:             bool,
	pub snapcompact:         bool,
	pub audio:               bool,
	pub local_assistance:    bool,
	pub syntax_highlighting: bool,
}

/// Capabilities of the loaded binary, not the launcher's settings.
#[napi]
pub fn native_capabilities() -> NativeCapabilities {
	NativeCapabilities {
		smollm:              cfg!(feature = "smollm"),
		live_voice:          cfg!(feature = "live-voice"),
		wasm_grammars:       cfg!(feature = "wasm-grammars"),
		pdf:                 cfg!(feature = "pdf"),
		jujutsu:             cfg!(feature = "vcs-jj"),
		snapcompact:         cfg!(feature = "snapcompact"),
		audio:               cfg!(feature = "audio"),
		local_assistance:    cfg!(feature = "local-assistance"),
		syntax_highlighting: cfg!(feature = "syntax-highlighting"),
	}
}
