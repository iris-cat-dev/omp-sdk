//! Windows capability namespace, rooted in a pinned local volume and directory.
//! Accepts drive-absolute roots (`C:\dir` and `\\?\C:\dir`), not UNC,
//! device, mapped-network or SUBST roots. Model paths always use `/`.
//! No operation resolves an absolute pathname after the root has been pinned.
use super::{denied, Buffer, Result, SandboxEntry, SandboxStat};
use std::{
	fs::File,
	io::{Read, Write},
	mem::{offset_of, size_of, size_of_val},
	os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
	ptr,
};
use windows_sys::{
	Wdk::{
		Foundation::OBJECT_ATTRIBUTES,
		Storage::FileSystem::{
			NtCreateFile, NtQueryDirectoryFile, NtQueryInformationFile, NtQueryVolumeInformationFile,
			NtSetInformationFile, FileBasicInformation, FileDirectoryInformation, FileDispositionInformation,
			FileFsDeviceInformation, FileRenameInformation, FileStandardInformation, FILE_BASIC_INFORMATION,
			FILE_CREATE, FILE_DIRECTORY_FILE, FILE_DIRECTORY_INFORMATION, FILE_DISPOSITION_INFORMATION,
			FILE_INFORMATION_CLASS, FILE_NON_DIRECTORY_FILE, FILE_OPEN, FILE_OPEN_IF,
			FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION, FILE_STANDARD_INFORMATION,
			FILE_SYNCHRONOUS_IO_NONALERT, NTCREATEFILE_CREATE_DISPOSITION, NTCREATEFILE_CREATE_OPTIONS,
		},
		System::SystemServices::{FILE_FS_DEVICE_INFORMATION, FILE_REMOTE_DEVICE},
	},
	Win32::{
		Foundation::{HANDLE, INVALID_HANDLE_VALUE, NTSTATUS, OBJ_CASE_INSENSITIVE,
			STATUS_NO_MORE_FILES, STATUS_OBJECT_NAME_NOT_FOUND, STATUS_SUCCESS, UNICODE_STRING},
		Storage::FileSystem::{
			GetFileType, GetVolumeNameForVolumeMountPointW, ReOpenFile, DELETE, FILE_ACCESS_RIGHTS,
			FILE_ATTRIBUTE_DEVICE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT,
			FILE_DEVICE_DISK, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
			FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_MODE, FILE_SHARE_READ,
			FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_TYPE_DISK, FILE_WRITE_DATA, SYNCHRONIZE,
		},
		System::{IO::IO_STATUS_BLOCK, Ioctl::FILE_DEVICE_DISK_FILE_SYSTEM},
	},
};

const MAX_BYTES: usize = 200 * 1024 * 1024;
const MAX_ENTRIES: usize = 1024;
const SHARE: FILE_SHARE_MODE = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
const DIRECTORY_ACCESS: FILE_ACCESS_RIGHTS = FILE_LIST_DIRECTORY | FILE_TRAVERSE;
const WINDOWS_EPOCH: i64 = 116_444_736_000_000_000;

fn component(value: &str) -> Result<()> {
	if value.is_empty() || value == "." || value == ".." || value.ends_with([' ', '.'])
		|| value.chars().any(|c| c < ' ' || matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*'))
		|| value.encode_utf16().count() > 255 {
		return Err(denied());
	}
	// Windows reserves these names even with an extension (including COM/LPT
	// superscript digits). Trimming the stem also rejects DOS device aliases.
	let stem = value.split('.').next().unwrap().trim_end_matches(' ');
	if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"].iter()
		.any(|device| stem.eq_ignore_ascii_case(device)) {
		return Err(denied());
	}
	if stem.get(..3).is_some_and(|prefix| prefix.eq_ignore_ascii_case("COM") || prefix.eq_ignore_ascii_case("LPT"))
		&& matches!(stem.get(3..), Some("1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")) {
		return Err(denied());
	}
	Ok(())
}

fn parts(value: &str, directory: bool) -> Result<Vec<&str>> {
	if directory && (value.is_empty() || value == ".") { return Ok(Vec::new()); }
	let components: Vec<_> = value.split('/').collect();
	for part in &components { component(part)?; }
	Ok(components)
}

fn native_open(
	parent: HANDLE, name: &str, access: FILE_ACCESS_RIGHTS, disposition: NTCREATEFILE_CREATE_DISPOSITION,
	options: NTCREATEFILE_CREATE_OPTIONS, share: FILE_SHARE_MODE,
) -> std::result::Result<OwnedHandle, NTSTATUS> {
	let mut name: Vec<u16> = name.encode_utf16().collect();
	let bytes = name.len().checked_mul(2).and_then(|bytes| u16::try_from(bytes).ok())
		.ok_or(STATUS_OBJECT_NAME_NOT_FOUND)?;
	let name = UNICODE_STRING { Length: bytes, MaximumLength: bytes, Buffer: name.as_mut_ptr() };
	let attributes = OBJECT_ATTRIBUTES {
		Length: size_of::<OBJECT_ATTRIBUTES>() as u32, RootDirectory: parent, ObjectName: &name,
		Attributes: OBJ_CASE_INSENSITIVE, SecurityDescriptor: ptr::null(), SecurityQualityOfService: ptr::null(),
	};
	let mut handle = ptr::null_mut();
	let mut io = IO_STATUS_BLOCK::default();
	// SAFETY: all counted UTF-16/object/status buffers live through this synchronous
	// call; parent is a live pinned handle (or null only for the volume root).
	// No backup intent or privilege bypass is requested. The final component is
	// opened itself, never its reparse target. Ownership is adopted only on success.
	let status = unsafe { NtCreateFile(
		&mut handle, access | FILE_READ_ATTRIBUTES | SYNCHRONIZE, &attributes, &mut io, ptr::null(),
		FILE_ATTRIBUTE_NORMAL, share, disposition, options | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
		ptr::null(), 0,
	) };
	if status != STATUS_SUCCESS { return Err(status); }
	// SAFETY: NtCreateFile succeeded and returned a newly owned file handle.
	Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn open_at(parent: HANDLE, name: &str, access: FILE_ACCESS_RIGHTS, disposition: NTCREATEFILE_CREATE_DISPOSITION,
	options: NTCREATEFILE_CREATE_OPTIONS, share: FILE_SHARE_MODE) -> Result<OwnedHandle> {
	// All callers supply one already-validated component, never an ambient path.
	native_open(parent, name, access, disposition, options, share).map_err(|_| denied())
}

fn query<T: Default>(handle: HANDLE, class: FILE_INFORMATION_CLASS) -> Result<T> {
	let mut out = T::default();
	let mut io = IO_STATUS_BLOCK::default();
	// SAFETY: the private callers pair each information class with its windows-sys
	// structure. The writable structure/status buffers outlive synchronous I/O.
	let status = unsafe { NtQueryInformationFile(handle, &mut io, (&mut out as *mut T).cast(), size_of::<T>() as u32, class) };
	if status != STATUS_SUCCESS || io.Information != size_of::<T>() { return Err(denied()); }
	Ok(out)
}

struct Metadata { basic: FILE_BASIC_INFORMATION, standard: FILE_STANDARD_INFORMATION }
impl Metadata {
	fn stat(&self) -> SandboxStat {
		SandboxStat { is_directory: self.standard.Directory, size: self.standard.EndOfFile as f64,
			modified_at: (self.basic.LastWriteTime as i128 - WINDOWS_EPOCH as i128) as f64 / 10_000.0 }
	}
}
fn metadata(handle: HANDLE) -> Result<Metadata> {
	// SAFETY: handle is borrowed from an OwnedHandle/File and remains live.
	if unsafe { GetFileType(handle) } != FILE_TYPE_DISK { return Err(denied()); }
	let basic: FILE_BASIC_INFORMATION = query(handle, FileBasicInformation)?;
	let standard: FILE_STANDARD_INFORMATION = query(handle, FileStandardInformation)?;
	if basic.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE) != 0
		|| (basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != standard.Directory
		|| standard.EndOfFile < 0 || standard.DeletePending
		|| (!standard.Directory && standard.NumberOfLinks != 1) {
		return Err(denied());
	}
	Ok(Metadata { basic, standard })
}
fn directory(handle: HANDLE) -> Result<()> {
	if !metadata(handle)?.standard.Directory { return Err(denied()); }
	Ok(())
}
fn regular(handle: HANDLE) -> Result<Metadata> {
	let info = metadata(handle)?;
	if info.standard.Directory { return Err(denied()); }
	Ok(info)
}
fn delete(handle: HANDLE) -> Result<()> {
	let disposition = FILE_DISPOSITION_INFORMATION { DeleteFile: true };
	let mut io = IO_STATUS_BLOCK::default();
	// SAFETY: the matching windows-sys disposition structure is valid for the
	// synchronous call; handle has DELETE access. This deletes the opened link,
	// not an untrusted name that could have been swapped after validation.
	let status = unsafe { NtSetInformationFile(handle, &mut io, (&disposition as *const FILE_DISPOSITION_INFORMATION).cast(),
		size_of::<FILE_DISPOSITION_INFORMATION>() as u32, FileDispositionInformation) };
	if status != STATUS_SUCCESS { return Err(denied()); }
	Ok(())
}

struct Temp { file: File, cleanup: bool }
impl Drop for Temp {
	fn drop(&mut self) {
		if self.cleanup { let _ = delete(self.file.as_raw_handle()); }
	}
}
fn publish(file: HANDLE, parent: HANDLE, target: &str, exclusive: bool) -> Result<()> {
	let name: Vec<u16> = target.encode_utf16().collect();
	let header = offset_of!(FILE_RENAME_INFORMATION, FileName);
	let length = header + name.len() * size_of::<u16>();
	// A typed allocation supplies the native structure's alignment and space for
	// its flexible UTF-16 tail; only the counted bytes are passed to the kernel.
	let mut storage = vec![FILE_RENAME_INFORMATION::default(); length.div_ceil(size_of::<FILE_RENAME_INFORMATION>())];
	let info = storage.as_mut_ptr();
	// SAFETY: storage has the required alignment and at least length bytes. Name
	// is disjoint and fits the flexible tail. Writing the union's bool field is
	// valid for FileRenameInformation (not its Ex/flags information class).
	unsafe {
		(*info).Anonymous.ReplaceIfExists = !exclusive;
		(*info).RootDirectory = parent;
		(*info).FileNameLength = (name.len() * 2) as u32;
		ptr::copy_nonoverlapping(name.as_ptr(), storage.as_mut_ptr().cast::<u8>().add(header).cast::<u16>(), name.len());
	}
	let mut io = IO_STATUS_BLOCK::default();
	// SAFETY: live DELETE-capable source and pinned parent handles; the matching
	// variable-length native buffer remains allocated through synchronous I/O.
	// ReplaceIfExists=false is atomic no-replace, not a pre-check emulation.
	let status = unsafe { NtSetInformationFile(file, &mut io, info.cast(), length as u32, FileRenameInformation) };
	if status != STATUS_SUCCESS { return Err(denied()); }
	Ok(())
}

pub struct Root { handle: OwnedHandle, max_bytes: usize }
impl Root {
	pub fn open(root: &str, max_bytes: u32) -> Result<Self> {
		if max_bytes == 0 || max_bytes as usize > MAX_BYTES { return Err(denied()); }
		let root = root.strip_prefix("\\\\?\\").unwrap_or(root);
		let bytes = root.as_bytes();
		if bytes.len() < 4 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || !matches!(bytes[2], b'\\' | b'/') {
			return Err(denied());
		}
		let components: Vec<_> = root[3..].split(['\\', '/']).collect();
		for part in &components { component(part)?; }
		let drive = [bytes[0] as u16, b':' as u16, b'\\' as u16, 0];
		let mut volume = [0_u16; 50];
		// SAFETY: NUL-terminated drive root and correctly sized writable output.
		// Resolving the mount to a volume GUID prevents an absolute drive/SUBST
		// mapping from hiding unchecked directory traversal inside the initial open.
		if unsafe { GetVolumeNameForVolumeMountPointW(drive.as_ptr(), volume.as_mut_ptr(), volume.len() as u32) } == 0 {
			return Err(denied());
		}
		let end = volume.iter().position(|unit| *unit == 0).ok_or_else(denied)?;
		let volume = String::from_utf16(&volume[..end]).map_err(|_| denied())?;
		let volume = volume.strip_prefix("\\\\?\\Volume{").and_then(|value| value.strip_suffix("}\\")).ok_or_else(denied)?;
		if volume.len() != 36 || !volume.bytes().enumerate().all(|(index, byte)|
			if [8, 13, 18, 23].contains(&index) { byte == b'-' } else { byte.is_ascii_hexdigit() }) {
			return Err(denied());
		}
		let mut handle = native_open(ptr::null_mut(), &format!("\\??\\Volume{{{volume}}}\\"), DIRECTORY_ACCESS,
			FILE_OPEN, FILE_DIRECTORY_FILE, SHARE).map_err(|_| denied())?;
		directory(handle.as_raw_handle())?;
		let mut device = FILE_FS_DEVICE_INFORMATION::default();
		let mut io = IO_STATUS_BLOCK::default();
		// SAFETY: matching fixed-size volume information/status buffers and a live
		// synchronous volume-root handle. Network filesystem handles are rejected.
		let status = unsafe { NtQueryVolumeInformationFile(handle.as_raw_handle(), &mut io,
			(&mut device as *mut FILE_FS_DEVICE_INFORMATION).cast(), size_of::<FILE_FS_DEVICE_INFORMATION>() as u32, FileFsDeviceInformation) };
		if status != STATUS_SUCCESS || io.Information != size_of::<FILE_FS_DEVICE_INFORMATION>()
			|| device.Characteristics & FILE_REMOTE_DEVICE != 0
			|| !matches!(device.DeviceType, FILE_DEVICE_DISK | FILE_DEVICE_DISK_FILE_SYSTEM) { return Err(denied()); }
		for part in components {
			handle = open_at(handle.as_raw_handle(), part, DIRECTORY_ACCESS, FILE_OPEN, FILE_DIRECTORY_FILE, SHARE)?;
			directory(handle.as_raw_handle())?;
		}
		// OwnedHandle is Send + Sync. All operations use independent opened handles
		// and cursors; no raw-pointer Send/Sync assertion or shared file offset.
		Ok(Self { handle, max_bytes: max_bytes as usize })
	}
	fn directory(&self, components: &[&str]) -> Result<OwnedHandle> {
		directory(self.handle.as_raw_handle())?;
		// SAFETY: ReOpenFile reopens the pinned object, not its former pathname.
		// It creates an independent directory cursor. BACKUP_SEMANTICS permits
		// directory handles; no backup privilege is enabled by this operation.
		let raw = unsafe { ReOpenFile(self.handle.as_raw_handle(), DIRECTORY_ACCESS | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
			SHARE, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT) };
		if raw == INVALID_HANDLE_VALUE || raw.is_null() { return Err(denied()); }
		// SAFETY: successful ReOpenFile returns a newly owned handle.
		let mut handle = unsafe { OwnedHandle::from_raw_handle(raw) };
		directory(handle.as_raw_handle())?;
		for part in components {
			handle = open_at(handle.as_raw_handle(), part, DIRECTORY_ACCESS, FILE_OPEN, FILE_DIRECTORY_FILE, SHARE)?;
			directory(handle.as_raw_handle())?;
		}
		Ok(handle)
	}
	pub fn read(&self, path: &str, limit: Option<u32>) -> Result<Buffer> {
		let limit = limit.map_or(self.max_bytes, |limit| limit as usize);
		if limit == 0 || limit > self.max_bytes { return Err(denied()); }
		let components = parts(path, false)?;
		let parent = self.directory(&components[..components.len() - 1])?;
		let handle = open_at(parent.as_raw_handle(), components[components.len() - 1], FILE_READ_DATA,
			FILE_OPEN, FILE_NON_DIRECTORY_FILE, SHARE)?;
		let info = regular(handle.as_raw_handle())?;
		if info.standard.EndOfFile > limit as i64 { return Err(denied()); }
		let mut file = File::from(handle);
		let mut bytes = Vec::with_capacity(info.standard.EndOfFile as usize);
		Read::by_ref(&mut file).take((limit + 1) as u64).read_to_end(&mut bytes).map_err(|_| denied())?;
		regular(file.as_raw_handle())?;
		if bytes.len() > limit { return Err(denied()); }
		Ok(bytes.into())
	}
	pub fn list(&self, path: &str) -> Result<Vec<SandboxEntry>> {
		let handle = self.directory(&parts(path, true)?)?;
		let mut entries = Vec::new();
		// Enough space for the native header and any accepted 255-unit component.
		let mut storage = [0_u64; 128];
		let mut restart = true;
		loop {
			let mut io = IO_STATUS_BLOCK::default();
			// SAFETY: writable buffer/status block, live synchronous directory handle,
			// no APC, and a matching information class. ReturnSingleEntry bounds each
			// response and gives this operation its own handle-bound enumeration cursor.
			let status = unsafe { NtQueryDirectoryFile(handle.as_raw_handle(), ptr::null_mut(), None, ptr::null(),
				&mut io, storage.as_mut_ptr().cast(), size_of_val(&storage) as u32, FileDirectoryInformation, true, ptr::null(), restart) };
			restart = false;
			if status == STATUS_NO_MORE_FILES { break; }
			if status != STATUS_SUCCESS || io.Information < offset_of!(FILE_DIRECTORY_INFORMATION, FileName)
				|| io.Information > size_of_val(&storage) { return Err(denied()); }
			// SAFETY: the completed response contains the fixed native header. The
			// whole backing buffer is initialized, including any trailing padding;
			// read_unaligned avoids imposing structure alignment on the byte buffer.
			let info = unsafe { ptr::read_unaligned(storage.as_ptr().cast::<FILE_DIRECTORY_INFORMATION>()) };
			let header = offset_of!(FILE_DIRECTORY_INFORMATION, FileName);
			let length = info.FileNameLength as usize;
			if info.NextEntryOffset != 0 || length == 0 || length % 2 != 0 || header + length > io.Information {
				return Err(denied());
			}
			// SAFETY: the validated counted name is within the initialized response;
			// the u64 buffer and the even native offset satisfy u16 alignment.
			let name = unsafe { std::slice::from_raw_parts(storage.as_ptr().cast::<u8>().add(header).cast::<u16>(), length / 2) };
			let name = String::from_utf16(name).map_err(|_| denied())?;
			if name == "." || name == ".." { continue; }
			component(&name)?;
			if entries.len() == MAX_ENTRIES { return Err(denied()); }
			let entry = open_at(handle.as_raw_handle(), &name, 0, FILE_OPEN, 0, SHARE)?;
			let info = metadata(entry.as_raw_handle())?.stat();
			entries.push(SandboxEntry { name, is_directory: info.is_directory, size: info.size, modified_at: info.modified_at });
		}
		entries.sort_by(|left, right| left.name.cmp(&right.name));
		Ok(entries)
	}
	pub fn write(&self, path: &str, bytes: &[u8], exclusive: bool) -> Result<()> {
		if bytes.len() > self.max_bytes { return Err(denied()); }
		let components = parts(path, false)?;
		let parent = self.directory(&components[..components.len() - 1])?;
		let target = components[components.len() - 1];
		match native_open(parent.as_raw_handle(), target, 0, FILE_OPEN, FILE_NON_DIRECTORY_FILE, SHARE) {
			Ok(handle) => { regular(handle.as_raw_handle())?; if exclusive { return Err(denied()); } }
			Err(STATUS_OBJECT_NAME_NOT_FOUND) => {}
			Err(_) => return Err(denied()),
		}
		let mut nonce = [0_u8; 16];
		getrandom::fill(&mut nonce).map_err(|_| denied())?;
		let name = format!(".sandbox-write-{:032x}", u128::from_ne_bytes(nonce));
		// Share-none keeps the fresh inode private through publication: another
		// opener cannot install a hardlink, mutate data or rename the temporary file.
		let handle = open_at(parent.as_raw_handle(), &name, FILE_WRITE_DATA | DELETE, FILE_CREATE, FILE_NON_DIRECTORY_FILE, 0)?;
		let mut temp = Temp { file: File::from(handle), cleanup: true };
		regular(temp.file.as_raw_handle())?;
		temp.file.write_all(bytes).map_err(|_| denied())?;
		temp.file.sync_all().map_err(|_| denied())?;
		regular(temp.file.as_raw_handle())?;
		// Replacing the directory entry never truncates a pre-existing inode,
		// including a hardlink swapped into target after the initial validation.
		publish(temp.file.as_raw_handle(), parent.as_raw_handle(), target, exclusive)?;
		temp.cleanup = false;
		Ok(())
	}
	pub fn metadata(&self, path: &str) -> Result<SandboxStat> {
		let components = parts(path, true)?;
		let handle = if components.is_empty() { self.directory(&[])? } else {
			let parent = self.directory(&components[..components.len() - 1])?;
			open_at(parent.as_raw_handle(), components[components.len() - 1], 0, FILE_OPEN, 0, SHARE)?
		};
		Ok(metadata(handle.as_raw_handle())?.stat())
	}
	pub fn mkdir(&self, path: &str) -> Result<()> {
		let components = parts(path, false)?;
		let mut handle = self.directory(&[])?;
		for part in components {
			handle = open_at(handle.as_raw_handle(), part, DIRECTORY_ACCESS, FILE_OPEN_IF, FILE_DIRECTORY_FILE, SHARE)?;
			directory(handle.as_raw_handle())?;
		}
		Ok(())
	}
	pub fn remove(&self, path: &str) -> Result<()> {
		let components = parts(path, false)?;
		let parent = self.directory(&components[..components.len() - 1])?;
		let handle = open_at(parent.as_raw_handle(), components[components.len() - 1], DELETE,
			FILE_OPEN, FILE_NON_DIRECTORY_FILE, SHARE)?;
		regular(handle.as_raw_handle())?;
		delete(handle.as_raw_handle())
	}
}
