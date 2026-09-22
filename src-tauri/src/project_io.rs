use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// 同目录写完整临时文件后再替换，不先截断或删除用户已有工程。
pub fn write_project(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if !path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("svgaproj"))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "只允许写入 .svgaproj 工程",
        ));
    }
    if bytes.is_empty() || bytes.len() > 128 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "工程为空或超过 128 MiB",
        ));
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let directory = fs::canonicalize(parent)?;
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "工程文件名无效"))?;
    let destination = directory.join(name);
    match fs::symlink_metadata(&destination) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "工程目标不能是目录或符号链接",
            ));
        }
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    for _ in 0..32 {
        let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let temporary = directory.join(format!(
            ".svga-project-{}-{}-{}.tmp",
            std::process::id(),
            stamp,
            serial
        ));
        let mut file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        let written = file.write_all(bytes).and_then(|_| file.sync_all());
        drop(file);
        let result = written.and_then(|_| fs::rename(&temporary, &destination));
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        return result;
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "无法创建唯一工程临时文件",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_and_replaces_only_projects() {
        let directory = std::env::temp_dir().join(format!(
            "svga-project-io-test-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        let target = directory.join("example.svgaproj");
        write_project(&target, b"first").unwrap();
        write_project(&target, b"next").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"next");
        assert!(write_project(&target, b"").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"next");
        assert!(write_project(&directory.join("original.svga"), b"no").is_err());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        fs::remove_file(target).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
