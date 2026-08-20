##############################################################################
# OpenDuck CLI Install Script for Windows PowerShell
#
# This script downloads the latest stable 'openduck' CLI binary from GitHub
# releases and installs it to your system. A 'goose' alias is also installed
# for backward compatibility.
#
# Supported OS: Windows
# Supported Architectures: x86_64
#
# Usage:
#   Invoke-WebRequest -Uri "https://github.com/aaif-goose/goose/releases/download/stable/download_cli.ps1" -OutFile "download_cli.ps1"; .\download_cli.ps1
#   Or simply: .\download_cli.ps1
#
# Environment variables:
#   $env:OPENDUCK_BIN_DIR / $env:GOOSE_BIN_DIR  - Install directory (default: $env:USERPROFILE\.local\bin)
#   $env:OPENDUCK_VERSION / $env:GOOSE_VERSION  - Optional: specific version (e.g., "v1.0.25"). Format: vX.Y.Z, vX.Y.Z-suffix, or X.Y.Z
#   $env:OPENDUCK_PROVIDER / $env:GOOSE_PROVIDER - Optional: provider for OpenDuck
#   $env:OPENDUCK_MODEL / $env:GOOSE_MODEL      - Optional: model for OpenDuck
#   $env:OPENDUCK_WINDOWS_VARIANT / $env:GOOSE_WINDOWS_VARIANT - Optional: Windows package variant ("standard" or "cuda")
#   $env:CANARY         - Optional: if set to "true", downloads from canary release instead of stable
#   $env:CONFIGURE      - Optional: if set to "false", disables running openduck configure interactively
#
# Release assets are named openduck-<target>.zip (primary). Older goose-<target>
# assets remain as aliases and are used as a fallback when installing historical versions.
##############################################################################

# Set error action preference to stop on errors
$ErrorActionPreference = "Stop"

# --- 1) Variables ---
$REPO = "aaif-goose/goose"
$OUT_FILE = "openduck.exe"
$LEGACY_OUT_FILE = "goose.exe"

# Set default bin directory if not specified
if (-not $env:OPENDUCK_BIN_DIR) {
    if ($env:GOOSE_BIN_DIR) {
        $env:OPENDUCK_BIN_DIR = $env:GOOSE_BIN_DIR
    } else {
        $env:OPENDUCK_BIN_DIR = Join-Path $env:USERPROFILE ".local\bin"
    }
}

# Determine release type
$RELEASE = if ($env:CANARY -eq "true") { "true" } else { "false" }
$CONFIGURE = if ($env:CONFIGURE -eq "false") { "false" } else { "true" }
$WINDOWS_VARIANT_RAW = if ($env:OPENDUCK_WINDOWS_VARIANT) { $env:OPENDUCK_WINDOWS_VARIANT } else { $env:GOOSE_WINDOWS_VARIANT }
$WINDOWS_VARIANT = if ($WINDOWS_VARIANT_RAW) { $WINDOWS_VARIANT_RAW.ToLowerInvariant() } else { "standard" }
$REQUESTED_VERSION = if ($env:OPENDUCK_VERSION) { $env:OPENDUCK_VERSION } else { $env:GOOSE_VERSION }

# Determine release tag
if ($REQUESTED_VERSION) {
    # Validate version format
    if ($REQUESTED_VERSION -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(-.*)?$') {
        Write-Error "Invalid version '$REQUESTED_VERSION'. Expected: semver format vX.Y.Z, vX.Y.Z-suffix, or X.Y.Z"
        exit 1
    }
    # Ensure version starts with 'v'
    $RELEASE_TAG = if ($REQUESTED_VERSION.StartsWith("v")) { $REQUESTED_VERSION } else { "v$REQUESTED_VERSION" }
} else {
    # Use canary or stable based on RELEASE variable
    $RELEASE_TAG = if ($RELEASE -eq "true") { "canary" } else { "stable" }
}

# --- 2) Detect Architecture ---
$ARCH = $env:PROCESSOR_ARCHITECTURE
if ($ARCH -eq "AMD64") {
    $ARCH = "x86_64"
} elseif ($ARCH -eq "ARM64") {
    Write-Error "Windows ARM64 is not currently supported."
    exit 1
} else {
    Write-Error "Unsupported architecture '$ARCH'. Only x86_64 is supported on Windows."
    exit 1
}

if ($WINDOWS_VARIANT -ne "standard" -and $WINDOWS_VARIANT -ne "cuda") {
    Write-Error "Unsupported OPENDUCK_WINDOWS_VARIANT '$WINDOWS_VARIANT'. Expected 'standard' or 'cuda'."
    exit 1
}

# --- 3) Build download URL ---
$FILE = if ($WINDOWS_VARIANT -eq "cuda") { "openduck-$ARCH-pc-windows-msvc-cuda.zip" } else { "openduck-$ARCH-pc-windows-msvc.zip" }
$LEGACY_FILE = if ($WINDOWS_VARIANT -eq "cuda") { "goose-$ARCH-pc-windows-msvc-cuda.zip" } else { "goose-$ARCH-pc-windows-msvc.zip" }

function Download-ReleaseAsset {
    param([string]$Tag, [string]$Asset)
    $Url = "https://github.com/$REPO/releases/download/$Tag/$Asset"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Asset -UseBasicParsing
        return $true
    } catch {
        return $false
    }
}

Write-Host "Downloading $RELEASE_TAG release: $FILE..." -ForegroundColor Green

# --- 4) Download the file ---
if (Download-ReleaseAsset -Tag $RELEASE_TAG -Asset $FILE) {
    Write-Host "Download completed successfully." -ForegroundColor Green
} elseif (Download-ReleaseAsset -Tag $RELEASE_TAG -Asset $LEGACY_FILE) {
    $FILE = $LEGACY_FILE
    Write-Host "Using legacy goose asset $FILE." -ForegroundColor Yellow
} else {
    Write-Error "Failed to download $FILE (and legacy alias $LEGACY_FILE) for $RELEASE_TAG."
    exit 1
}

# --- 5) Create temporary directory for extraction ---
$TMP_DIR = Join-Path $env:TEMP "openduck_install_$(Get-Random)"
try {
    New-Item -ItemType Directory -Path $TMP_DIR -Force | Out-Null
    Write-Host "Created temporary directory: $TMP_DIR" -ForegroundColor Yellow
} catch {
    Write-Error "Could not create temporary extraction directory: $TMP_DIR"
    exit 1
}

# --- 6) Extract the archive ---
Write-Host "Extracting $FILE to temporary directory..." -ForegroundColor Green
try {
    Expand-Archive -Path $FILE -DestinationPath $TMP_DIR -Force
    Write-Host "Extraction completed successfully." -ForegroundColor Green
} catch {
    Write-Error "Failed to extract $FILE. Error: $($_.Exception.Message)"
    Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

# Clean up the downloaded archive
Remove-Item -Path $FILE -Force

# --- 7) Determine extraction directory ---
$EXTRACT_DIR = $TMP_DIR
if (Test-Path (Join-Path $TMP_DIR "openduck-package")) {
    Write-Host "Found openduck-package subdirectory, using that as extraction directory" -ForegroundColor Yellow
    $EXTRACT_DIR = Join-Path $TMP_DIR "openduck-package"
} elseif (Test-Path (Join-Path $TMP_DIR "goose-package")) {
    Write-Host "Found goose-package subdirectory, using that as extraction directory" -ForegroundColor Yellow
    $EXTRACT_DIR = Join-Path $TMP_DIR "goose-package"
}

# --- 8) Create bin directory if it doesn't exist ---
if (-not (Test-Path $env:OPENDUCK_BIN_DIR)) {
    Write-Host "Creating directory: $env:OPENDUCK_BIN_DIR" -ForegroundColor Yellow
    try {
        New-Item -ItemType Directory -Path $env:OPENDUCK_BIN_DIR -Force | Out-Null
    } catch {
        Write-Error "Could not create directory: $env:OPENDUCK_BIN_DIR"
        Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
        exit 1
    }
}

# --- 9) Install OpenDuck binary and goose alias ---
$SOURCE_OPENDUCK = Join-Path $EXTRACT_DIR "openduck.exe"
$SOURCE_GOOSE = Join-Path $EXTRACT_DIR "goose.exe"
if (Test-Path $SOURCE_OPENDUCK) {
    $SOURCE_BIN = $SOURCE_OPENDUCK
} elseif (Test-Path $SOURCE_GOOSE) {
    $SOURCE_BIN = $SOURCE_GOOSE
} else {
    Write-Error "neither openduck.exe nor goose.exe found in extracted files"
    Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
}

$DEST_OPENDUCK = Join-Path $env:OPENDUCK_BIN_DIR $OUT_FILE
$DEST_GOOSE = Join-Path $env:OPENDUCK_BIN_DIR $LEGACY_OUT_FILE

function Install-Binary {
    param([string]$Destination)
    Write-Host "Installing OpenDuck to $Destination" -ForegroundColor Green
    try {
        if (Test-Path $Destination) {
            Remove-Item -Path $Destination -Force
        }
        Copy-Item -Path $SOURCE_BIN -Destination $Destination -Force
    } catch {
        Write-Error "Failed to install to $Destination. Error: $($_.Exception.Message)"
        Remove-Item -Path $TMP_DIR -Recurse -Force -ErrorAction SilentlyContinue
        exit 1
    }
}

Install-Binary -Destination $DEST_OPENDUCK
Install-Binary -Destination $DEST_GOOSE

# --- 10) Copy Windows runtime DLLs if they exist ---
$DLL_FILES = Get-ChildItem -Path $EXTRACT_DIR -Filter "*.dll" -ErrorAction SilentlyContinue
foreach ($dll in $DLL_FILES) {
    $DEST_DLL = Join-Path $env:OPENDUCK_BIN_DIR $dll.Name
    Write-Host "Moving Windows runtime DLL: $($dll.Name)" -ForegroundColor Green
    try {
        # Remove existing file if it exists to avoid conflicts
        if (Test-Path $DEST_DLL) {
            Remove-Item -Path $DEST_DLL -Force
        }
        Move-Item -Path $dll.FullName -Destination $DEST_DLL -Force
    } catch {
        Write-Warning "Failed to move $($dll.Name): $($_.Exception.Message)"
    }
}

# --- 11) Clean up temporary directory ---
try {
    Remove-Item -Path $TMP_DIR -Recurse -Force
    Write-Host "Cleaned up temporary directory." -ForegroundColor Yellow
} catch {
    Write-Warning "Could not clean up temporary directory: $TMP_DIR"
}

# --- 12) Configure OpenDuck (Optional) ---
if ($CONFIGURE -eq "true") {
    Write-Host ""
    Write-Host "Configuring OpenDuck" -ForegroundColor Green
    Write-Host ""
    try {
        & $DEST_OPENDUCK configure
    } catch {
        Write-Warning "Failed to run openduck configure. You may need to run it manually later."
    }
} else {
    Write-Host "Skipping 'openduck configure', you may need to run this manually later" -ForegroundColor Yellow
}

# --- 13) Check PATH and give instructions if needed ---
$CURRENT_PATH = $env:PATH
if ($CURRENT_PATH -notlike "*$env:OPENDUCK_BIN_DIR*") {
    Write-Host ""
    Write-Host "Warning: OpenDuck installed, but $env:OPENDUCK_BIN_DIR is not in your PATH." -ForegroundColor Yellow
    Write-Host "To add it to your PATH permanently, run the following command as Administrator:" -ForegroundColor Yellow
    Write-Host "    [Environment]::SetEnvironmentVariable('PATH', `$env:PATH + ';$env:OPENDUCK_BIN_DIR', 'Machine')" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Or add it to your user PATH (no admin required):" -ForegroundColor Yellow
    Write-Host "    [Environment]::SetEnvironmentVariable('PATH', `$env:PATH + ';$env:OPENDUCK_BIN_DIR', 'User')" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "For this session only, you can run:" -ForegroundColor Yellow
    Write-Host "    `$env:PATH += ';$env:OPENDUCK_BIN_DIR'" -ForegroundColor Cyan
    Write-Host ""
}

Write-Host "OpenDuck CLI installation completed successfully!" -ForegroundColor Green
Write-Host "openduck is installed at: $DEST_OPENDUCK" -ForegroundColor Green
Write-Host "Legacy goose alias is installed at: $DEST_GOOSE" -ForegroundColor Green
