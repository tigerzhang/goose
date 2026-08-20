#!/usr/bin/env bash
set -eu

##############################################################################
# OpenDuck CLI Install Script
#
# This script downloads the latest stable 'openduck' CLI binary from GitHub
# releases and installs it to your system. A 'goose' alias is also installed
# for backward compatibility.
#
# Supported OS: macOS (darwin), Linux, Windows (MSYS2/Git Bash/WSL), Android (Termux)
# Supported Architectures: x86_64, arm64
#
# Usage:
#   curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash
#
# Environment variables:
#   OPENDUCK_BIN_DIR / GOOSE_BIN_DIR  - Install directory (default: $HOME/.local/bin)
#   OPENDUCK_VERSION / GOOSE_VERSION  - Optional: specific version (e.g., "v1.0.25"). Overrides CANARY. Format: vX.Y.Z, vX.Y.Z-suffix, or X.Y.Z
#   OPENDUCK_PROVIDER / GOOSE_PROVIDER - Optional: provider for OpenDuck
#   OPENDUCK_MODEL / GOOSE_MODEL      - Optional: model for OpenDuck
#   OPENDUCK_LINUX_VARIANT / GOOSE_LINUX_VARIANT - Optional: Linux package variant (`standard`, `vulkan`, or `musl`)
#   OPENDUCK_WINDOWS_VARIANT / GOOSE_WINDOWS_VARIANT - Optional: Windows package variant (`standard` or `cuda`)
#   CANARY         - Optional: if set to "true", downloads from canary release instead of stable
#   CONFIGURE      - Optional: if set to "false", disables running openduck configure interactively
#   ** other provider specific environment variables (eg. DATABRICKS_HOST)
#
# Release assets are named openduck-<target>.tar.bz2 (primary). Older goose-<target>
# assets remain as aliases and are used as a fallback when installing historical versions.
##############################################################################

# --- 1) Check for dependencies ---
# Check for curl
if ! command -v curl >/dev/null 2>&1; then
  echo "Error: 'curl' is required to download OpenDuck. Please install curl and try again."
  exit 1
fi

# Check for tar or unzip (depending on OS)
if ! command -v tar >/dev/null 2>&1 && ! command -v unzip >/dev/null 2>&1; then
  echo "Error: Either 'tar' or 'unzip' is required to extract OpenDuck. Please install one and try again."
  exit 1
fi

# Check for required extraction tools based on detected OS
if [ "${OS:-}" = "windows" ]; then
  # Windows uses PowerShell's built-in Expand-Archive - check if PowerShell is available
  if ! command -v powershell.exe >/dev/null 2>&1 && ! command -v pwsh >/dev/null 2>&1; then
    echo "Warning: PowerShell is recommended to extract Windows packages but was not found."
    echo "Falling back to unzip if available."
  fi
else
  if ! command -v tar >/dev/null 2>&1; then
    echo "Error: 'tar' is required to extract packages for ${OS:-unknown}. Please install tar and try again."
    exit 1
  fi
fi


# --- 2) Variables ---
REPO="aaif-goose/goose"
OUT_FILE="openduck"
LEGACY_OUT_FILE="goose"

# Set default bin directory based on detected OS environment
if [[ "${WINDIR:-}" ]] || [[ "${windir:-}" ]] || [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    # Native Windows environments - use Windows user profile path
    DEFAULT_BIN_DIR="$USERPROFILE/openduck"
else
    # Linux, macOS, and WSL all use the same bin directory
    DEFAULT_BIN_DIR="$HOME/.local/bin"
fi

OPENDUCK_BIN_DIR="${OPENDUCK_BIN_DIR:-${GOOSE_BIN_DIR:-$DEFAULT_BIN_DIR}}"
RELEASE="${CANARY:-false}"
CONFIGURE="${CONFIGURE:-true}"
OPENDUCK_LINUX_VARIANT="${OPENDUCK_LINUX_VARIANT:-${GOOSE_LINUX_VARIANT:-}}"
OPENDUCK_WINDOWS_VARIANT="${OPENDUCK_WINDOWS_VARIANT:-${GOOSE_WINDOWS_VARIANT:-standard}}"
OPENDUCK_VERSION="${OPENDUCK_VERSION:-${GOOSE_VERSION:-}}"
if [ -n "${OPENDUCK_VERSION}" ]; then
  # Validate the version format
  if [[ ! "$OPENDUCK_VERSION" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-.*)?$ ]]; then
    echo "[error]: invalid version '$OPENDUCK_VERSION'."
    echo "  expected: semver format vX.Y.Z, vX.Y.Z-suffix, or X.Y.Z"
    exit 1
  fi
  OPENDUCK_VERSION=$(echo "$OPENDUCK_VERSION" | sed 's/^v\{0,1\}/v/') # Ensure the version string is prefixed with 'v' if not already present
  RELEASE_TAG="$OPENDUCK_VERSION"
else
  # If OPENDUCK_VERSION/GOOSE_VERSION is not set, fall back to existing behavior for backwards compatibility
  RELEASE_TAG="$([[ "$RELEASE" == "true" ]] && echo "canary" || echo "stable")"
fi

# --- 3) Detect OS/Architecture ---
# Allow explicit override for automation or when auto-detection is wrong:
#   INSTALL_OS=linux|windows|darwin
if [ -n "${INSTALL_OS:-}" ]; then
  case "${INSTALL_OS}" in
    linux|windows|darwin) OS="${INSTALL_OS}" ;;
    *) echo "[error]: unsupported INSTALL_OS='${INSTALL_OS}' (expected: linux|windows|darwin)"; exit 1 ;;
  esac
else
  # Better OS detection for Windows environments, with safer WSL handling.
  # If explicit Windows-like shells/variables are present (MSYS/Cygwin), treat as windows.
  if [[ "${WINDIR:-}" ]] || [[ "${windir:-}" ]] || [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    OS="windows"
  elif [[ -n "${TERMUX_VERSION:-}" ]]; then
    # Termux on Android: treat as Linux before the Windows mount heuristic,
    # since /d may exist on Android and would incorrectly match as Windows.
    OS="linux"
  elif [[ -f "/proc/version" ]] && grep -q "Microsoft\|WSL" /proc/version 2>/dev/null; then
    # WSL is a Linux environment regardless of the current working directory.
    # The PWD (e.g. /mnt/c/) does not change the kernel — always install Linux.
    OS="linux"
  elif [[ "$OSTYPE" == "darwin"* ]]; then
    OS="darwin"
  elif [[ "$PWD" =~ ^/[a-zA-Z]/ ]] && [[ -d "/c" || -d "/d" || -d "/e" ]]; then
    # Check for Windows-style mount points (like in Git Bash)
    OS="windows"
  else
    # Fallback to uname for other systems
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
  fi
fi

ARCH=$(uname -m)

# Handle Windows environments (MSYS2, Git Bash, Cygwin, WSL)
case "$OS" in
  linux|darwin|windows) ;;
  mingw*|msys*|cygwin*)
    OS="windows"
    ;;
  *)
    echo "Error: Unsupported OS '$OS'. OpenDuck currently supports Linux, macOS, and Windows."
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64)
    ARCH="x86_64"
    ;;
  arm64|aarch64)
    # Some systems use 'arm64' and some 'aarch64' – standardize to 'aarch64'
    ARCH="aarch64"
    ;;
  *)
    echo "Error: Unsupported architecture '$ARCH'."
    exit 1
    ;;
esac

detect_linux_musl() {
  if [[ "$OSTYPE" == "linux-musl"* ]]; then
    return 0
  fi

  if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
    return 0
  fi

  return 1
}

# Termux on Android: the musl portable build is the best fit (no system-keyring, no local-inference).
if [ "$OS" = "linux" ] && [ -n "${TERMUX_VERSION:-}" ] && [ -z "$OPENDUCK_LINUX_VARIANT" ]; then
  echo "Termux detected (v$TERMUX_VERSION). Using musl portable build."
  OPENDUCK_LINUX_VARIANT="musl"
fi

if [ "$OS" = "linux" ] && [ -z "$OPENDUCK_LINUX_VARIANT" ]; then
  if detect_linux_musl; then
    OPENDUCK_LINUX_VARIANT="musl"
  else
    OPENDUCK_LINUX_VARIANT="standard"
  fi
elif [ -z "$OPENDUCK_LINUX_VARIANT" ]; then
  OPENDUCK_LINUX_VARIANT="standard"
fi

# Debug output (safely handle undefined variables)
echo "WINDIR: ${WINDIR:-<not set>}"
echo "OSTYPE: $OSTYPE"
echo "uname -s: $(uname -s)"
echo "uname -m: $(uname -m)"
echo "PWD: $PWD"

# Output the detected OS
echo "Detected OS: $OS with ARCH $ARCH"

# Build the filename and URL for the stable release.
# Primary assets are openduck-*; goose-* names remain as aliases for older releases.
if [ "$OS" = "darwin" ]; then
  FILE="openduck-$ARCH-apple-darwin.tar.bz2"
  LEGACY_FILE="goose-$ARCH-apple-darwin.tar.bz2"
  EXTRACT_CMD="tar"
elif [ "$OS" = "windows" ]; then
  case "$OPENDUCK_WINDOWS_VARIANT" in
    standard|cuda) ;;
    *)
      echo "Error: Unsupported OPENDUCK_WINDOWS_VARIANT '$OPENDUCK_WINDOWS_VARIANT'. Expected 'standard' or 'cuda'."
      exit 1
      ;;
  esac
  # Windows only supports x86_64 currently
  if [ "$ARCH" != "x86_64" ]; then
    echo "Error: Windows currently only supports x86_64 architecture."
    exit 1
  fi
  FILE="openduck-$ARCH-pc-windows-msvc.zip"
  LEGACY_FILE="goose-$ARCH-pc-windows-msvc.zip"
  if [ "$OPENDUCK_WINDOWS_VARIANT" = "cuda" ]; then
    FILE="openduck-$ARCH-pc-windows-msvc-cuda.zip"
    LEGACY_FILE="goose-$ARCH-pc-windows-msvc-cuda.zip"
  fi
  EXTRACT_CMD="unzip"
  OUT_FILE="openduck.exe"
  LEGACY_OUT_FILE="goose.exe"
else
  case "$OPENDUCK_LINUX_VARIANT" in
    standard|vulkan|musl) ;;
    *)
      echo "Error: Unsupported OPENDUCK_LINUX_VARIANT '$OPENDUCK_LINUX_VARIANT'. Expected 'standard', 'vulkan', or 'musl'."
      exit 1
      ;;
  esac
  FILE="openduck-$ARCH-unknown-linux-gnu.tar.bz2"
  LEGACY_FILE="goose-$ARCH-unknown-linux-gnu.tar.bz2"
  if [ "$OPENDUCK_LINUX_VARIANT" = "vulkan" ]; then
    FILE="openduck-$ARCH-unknown-linux-gnu-vulkan.tar.bz2"
    LEGACY_FILE="goose-$ARCH-unknown-linux-gnu-vulkan.tar.bz2"
  elif [ "$OPENDUCK_LINUX_VARIANT" = "musl" ]; then
    FILE="openduck-$ARCH-unknown-linux-musl.tar.bz2"
    LEGACY_FILE="goose-$ARCH-unknown-linux-musl.tar.bz2"
  fi
  EXTRACT_CMD="tar"
fi

download_release_asset() {
  local tag="$1"
  local asset="$2"
  local url="https://github.com/$REPO/releases/download/$tag/$asset"
  if curl -sLf "$url" --output "$asset"; then
    FILE="$asset"
    DOWNLOAD_URL="$url"
    return 0
  fi
  return 1
}

# --- 4) Download & extract the OpenDuck binary ---
echo "Downloading $RELEASE_TAG release: $FILE..."
if ! download_release_asset "$RELEASE_TAG" "$FILE"; then
  echo "Primary asset $FILE not found; trying legacy alias $LEGACY_FILE..."
  if download_release_asset "$RELEASE_TAG" "$LEGACY_FILE"; then
    echo "Using legacy goose asset $LEGACY_FILE"
  elif ! [ -n "${OPENDUCK_VERSION}" ] && [ "${CANARY:-false}" != "true" ]; then
    LATEST_TAG=$(curl -s https://api.github.com/repos/aaif-goose/goose/releases/latest | \
      grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
    if [ -z "$LATEST_TAG" ]; then
      echo "Error: Failed to download $FILE and latest tag unavailable"
      exit 1
    fi
    if download_release_asset "$LATEST_TAG" "$FILE" || download_release_asset "$LATEST_TAG" "$LEGACY_FILE"; then
      echo "Using fallback tag $LATEST_TAG asset $FILE"
    else
      echo "Error: Failed to download from fallback tag $LATEST_TAG"
      exit 1
    fi
  else
    echo "Error: Failed to download $FILE (and legacy alias $LEGACY_FILE) for $RELEASE_TAG"
    exit 1
  fi
fi

# Create a temporary directory for extraction
TMP_DIR="${TMPDIR:-/tmp}/openduck_install_$RANDOM"
if ! mkdir -p "$TMP_DIR"; then
  echo "Error: Could not create temporary extraction directory"
  exit 1
fi
# Clean up temporary directory
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Extracting $FILE to temporary directory..."
set +e  # Disable immediate exit on error

if [ "$EXTRACT_CMD" = "tar" ]; then
  tar -xjf "$FILE" -C "$TMP_DIR" 2> tar_error.log
  extract_exit_code=$?

  # Check for tar errors
  if [ $extract_exit_code -ne 0 ]; then
    if grep -iEq "missing.*bzip2|bzip2.*missing|bzip2.*No such file|No such file.*bzip2" tar_error.log; then
      echo "Error: Failed to extract $FILE. 'bzip2' is required but not installed. See details below:"
    else
      echo "Error: Failed to extract $FILE. See details below:"
    fi
    cat tar_error.log
    rm tar_error.log
    exit 1
  fi
  rm tar_error.log
else
  # Use unzip for Windows
  unzip -q "$FILE" -d "$TMP_DIR" 2> unzip_error.log
  extract_exit_code=$?

  # Check for unzip errors
  if [ $extract_exit_code -ne 0 ]; then
    echo "Error: Failed to extract $FILE. See details below:"
    cat unzip_error.log
    rm unzip_error.log
    exit 1
  fi
  rm unzip_error.log
fi

set -e  # Re-enable immediate exit on error

rm "$FILE" # clean up the downloaded archive

# Determine the extraction directory (handle subdirectory in Windows packages)
# Windows releases may contain files in an 'openduck-package' or 'goose-package' subdirectory
EXTRACT_DIR="$TMP_DIR"
if [ "$OS" = "windows" ]; then
  if [ -d "$TMP_DIR/openduck-package" ]; then
    echo "Found openduck-package subdirectory, using that as extraction directory"
    EXTRACT_DIR="$TMP_DIR/openduck-package"
  elif [ -d "$TMP_DIR/goose-package" ]; then
    echo "Found goose-package subdirectory, using that as extraction directory"
    EXTRACT_DIR="$TMP_DIR/goose-package"
  fi
fi

if [ "$OS" = "windows" ]; then
  if [ -f "$EXTRACT_DIR/openduck.exe" ]; then
    SOURCE_BIN="$EXTRACT_DIR/openduck.exe"
  elif [ -f "$EXTRACT_DIR/goose.exe" ]; then
    SOURCE_BIN="$EXTRACT_DIR/goose.exe"
  else
    echo "Error: neither openduck.exe nor goose.exe found in extracted files"
    exit 1
  fi
else
  if [ -f "$EXTRACT_DIR/openduck" ]; then
    SOURCE_BIN="$EXTRACT_DIR/openduck"
  elif [ -f "$EXTRACT_DIR/goose" ]; then
    SOURCE_BIN="$EXTRACT_DIR/goose"
  else
    echo "Error: neither openduck nor goose binary found in extracted files"
    exit 1
  fi
fi
chmod +x "$SOURCE_BIN"

# --- 5) Install to $OPENDUCK_BIN_DIR ---
if [ ! -d "$OPENDUCK_BIN_DIR" ]; then
  echo "Creating directory: $OPENDUCK_BIN_DIR"
  mkdir -p "$OPENDUCK_BIN_DIR"
fi

install_bin() {
  local dest="$1"
  echo "Installing OpenDuck to $dest"
  if [ "$OS" = "windows" ]; then
    rm -f "$dest"
    cp "$SOURCE_BIN" "$dest"
  else
    # On Linux, if the target binary is currently running, writing to it fails
    # with ETXTBSY ("Text file busy"). Rename the old binary out of the way
    # first, then copy the new one in. If the copy fails, restore the old binary
    # so the user is never left without an executable.
    if [ -f "$dest" ]; then
      mv "$dest" "$dest.old"
      if ! cp "$SOURCE_BIN" "$dest"; then
        echo "Error: failed to install new binary, restoring previous version"
        mv "$dest.old" "$dest"
        exit 1
      fi
      rm -f "$dest.old"
    else
      cp "$SOURCE_BIN" "$dest"
    fi
    chmod +x "$dest"
  fi
}

install_bin "$OPENDUCK_BIN_DIR/$OUT_FILE"
install_bin "$OPENDUCK_BIN_DIR/$LEGACY_OUT_FILE"

# Copy Windows runtime DLLs if they exist
if [ "$OS" = "windows" ]; then
  for dll in "$EXTRACT_DIR"/*.dll; do
    if [ -f "$dll" ]; then
      echo "Moving Windows runtime DLL: $(basename "$dll")"
      mv "$dll" "$OPENDUCK_BIN_DIR/"
    fi
  done
fi

# skip configuration for non-interactive installs e.g. automation, docker
if [ "$CONFIGURE" = true ]; then
  # --- 6) Configure OpenDuck (Optional) ---
  echo ""
  echo "Configuring OpenDuck"
  echo ""
  if [ -t 0 ]; then
    "$OPENDUCK_BIN_DIR/$OUT_FILE" configure
  elif [ -r /dev/tty ]; then
    "$OPENDUCK_BIN_DIR/$OUT_FILE" configure < /dev/tty
  else
    echo "Non-interactive shell detected (e.g. 'curl ... | bash')."
    echo "Skipping 'openduck configure' — please run it manually after installation:"
    echo "    $OPENDUCK_BIN_DIR/$OUT_FILE configure"
  fi
else
  echo "Skipping 'openduck configure', you may need to run this manually later"
fi



# --- 7) Check PATH and give instructions if needed ---
if [[ ":$PATH:" != *":$OPENDUCK_BIN_DIR:"* ]]; then
  echo ""
  echo "Warning: OpenDuck installed, but $OPENDUCK_BIN_DIR is not in your PATH."

  if [ "$OS" = "windows" ]; then
    echo "To add OpenDuck to your PATH in PowerShell:"
    echo ""
    echo "# Add to your PowerShell profile"
    echo '$profilePath = $PROFILE'
    echo 'if (!(Test-Path $profilePath)) { New-Item -Path $profilePath -ItemType File -Force }'
    echo 'Add-Content -Path $profilePath -Value ''$env:PATH = "$env:USERPROFILE\.local\bin;$env:PATH"'''
    echo "# Reload profile or restart PowerShell"
    echo '. $PROFILE'
    echo ""
    echo "Alternatively, you can run:"
    echo "    openduck configure"
    echo "or rerun this install script after updating your PATH."
  else
    SHELL_NAME=$(basename "$SHELL")

    echo ""
    echo "The install directory is not in your PATH."

    if [ "$CONFIGURE" = true ]; then
      echo "What would you like to do?"
      echo "1) Add it for me"
      echo "2) I'll add it myself, show instructions"

      # Check whether stdin is a terminal. If it is not (for example, if
      # this script has been piped into bash), we need to explicitly read user's
      # choice from /dev/tty.
      if [ -t 0 ]; then # terminal
        read -p "Enter choice [1/2]: " choice
      elif [ -r /dev/tty ]; then # not a terminal, but /dev/tty is available
        read -p "Enter choice [1/2]: " choice < /dev/tty
      else # non-interactive environment without /dev/tty
        echo "Non-interactive environment detected without /dev/tty; defaulting to option 2 (show instructions)."
        choice=2
      fi

      case "$choice" in
      1)
        RC_FILE="$HOME/.${SHELL_NAME}rc"
        echo "Adding $OPENDUCK_BIN_DIR to $RC_FILE..."
        echo "export PATH=\"$OPENDUCK_BIN_DIR:\$PATH\"" >> "$RC_FILE"
        echo "Done! Reload your shell or run 'source $RC_FILE' to apply changes."
        ;;
      2)
        echo ""
        echo "Add it to your PATH by editing ~/.${SHELL_NAME}rc or similar:"
        echo "    export PATH=\"$OPENDUCK_BIN_DIR:\$PATH\""
        echo "Then reload your shell (e.g. 'source ~/.${SHELL_NAME}rc') to apply changes."
        ;;
      *)
        echo "Invalid choice. Please add $OPENDUCK_BIN_DIR to your PATH manually."
        ;;
      esac
    else
      echo ""
      echo "Configure disabled. Please add $OPENDUCK_BIN_DIR to your PATH manually."
    fi

  fi

  echo ""
fi

echo "OpenDuck CLI installation completed successfully!"
echo "openduck is installed at: $OPENDUCK_BIN_DIR/$OUT_FILE"
echo "Legacy goose alias is installed at: $OPENDUCK_BIN_DIR/$LEGACY_OUT_FILE"
