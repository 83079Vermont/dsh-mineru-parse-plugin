# MinerU parsing wrapper: cache, batch, cleanup, validation
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]]$Paths,

    [string]$OutDir,

    [ValidateSet('auto', 'hybrid-engine', 'pipeline', 'vlm-engine')]
    [string]$Backend = 'auto',

    [switch]$Force,

    [switch]$KeepImages,

    [switch]$NoFormula,

    [ValidateSet('auto', 'txt', 'ocr')]
    [string]$Method = 'auto',

    [string]$Lang = 'ch',

    [ValidateSet('medium', 'high')]
    [string]$Effort = 'medium'
)

function Resolve-MineruPaths {
    $scriptDir = $PSScriptRoot
    $configPath = $null
    foreach ($c in @((Join-Path $scriptDir 'mineru.config.json'), (Join-Path (Join-Path $env:USERPROFILE '.config\mineru') 'mineru.config.json'))) {
        if (Test-Path -LiteralPath $c) { $configPath = $c; break }
    }
    $config = $null
    if ($configPath) {
        try { $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } catch { }
    }

    $mineruBat = $null
    $venvPy = $null
    if ($env:MINERU_BAT) {
        $mineruBat = $env:MINERU_BAT
    }
    elseif ($config -and $config.mineruBat) {
        $mineruBat = $config.mineruBat
    }
    elseif (Test-Path 'D:\MinerU\mineru.bat') {
        $mineruBat = 'D:\MinerU\mineru.bat'
    }
    elseif (Get-Command mineru -ErrorAction SilentlyContinue) {
        $mineruBat = (Get-Command mineru).Source
    }
    if (-not $mineruBat) {
        return $null
    }

    if ($config -and $config.venvPython) {
        $venvPy = $config.venvPython
    }
    else {
        $base = Split-Path -Parent $mineruBat
        $cand = Join-Path (Join-Path $base '.venv\Scripts') 'python.exe'
        if (Test-Path -LiteralPath $cand) { $venvPy = $cand }
    }
    return [pscustomobject]@{ MineruBat = $mineruBat; VenvPy = $venvPy }
}

$mineru = Resolve-MineruPaths
if (-not $mineru) {
    Write-Host 'MINERU_UNAVAILABLE'
    exit 3
}
$mineruBat = $mineru.MineruBat
$venvPy = $mineru.VenvPy

$supported = @('.pdf', '.docx', '.pptx', '.xlsx', '.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff')
$files = @()
foreach ($p in $Paths) {
    $resolved = Resolve-Path -LiteralPath $p -ErrorAction SilentlyContinue
    if (-not $resolved) { continue }
    $ext = [IO.Path]::GetExtension($resolved.Path).ToLower()
    if ($supported -contains $ext) { $files += $resolved.Path }
}
if ($files.Count -eq 0) {
    Write-Host 'NO_SUPPORTED_FILES'
    exit 4
}

$useTempOut = $false
if (-not $OutDir) {
    if ($files.Count -eq 1) {
        $OutDir = Split-Path -Parent $files[0]
    }
    else {
        $OutDir = Join-Path $env:TEMP ("mineru_out_" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
        $useTempOut = $true
    }
}
if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

function Get-PageCount([string]$filePath) {
    if ([IO.Path]::GetExtension($filePath).ToLower() -ne '.pdf') { return 1 }
    if ($venvPy -and (Test-Path -LiteralPath $venvPy)) {
        try {
            $out = & $venvPy -c "import sys; from pypdfium2 import PdfDocument; d=PdfDocument(sys.argv[1]); print(len(d))" $filePath 2>$null
            $last = @($out | Select-Object -Last 1)
            if ($last.Count -gt 0) {
                $n = 0
                if ([int]::TryParse([string]$last[0], [ref]$n)) { return $n }
            }
        }
        catch { }
    }
    return 1
}

function Find-MdByStem([string]$outRoot, [string]$stem) {
    $dir = Join-Path $outRoot $stem
    if (-not (Test-Path -LiteralPath $dir)) { return $null }
    $mds = @(Get-ChildItem -LiteralPath $dir -Recurse -Filter '*.md' -ErrorAction SilentlyContinue)
    if ($mds.Count -eq 0) { return $null }
    return ($mds | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
}

function Invoke-OutputCleanup([string]$stemDir, [bool]$keepImgs) {
    if (-not (Test-Path -LiteralPath $stemDir)) { return }
    $files = @(Get-ChildItem -LiteralPath $stemDir -Recurse -File -ErrorAction SilentlyContinue)
    foreach ($file in $files) {
        if ($file.Extension -ieq '.md') { continue }
        if ($keepImgs -and $file.FullName -like '*\images\*') { continue }
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    }
    $dirs = @(Get-ChildItem -LiteralPath $stemDir -Recurse -Directory -ErrorAction SilentlyContinue |
        Sort-Object { $_.FullName.Length } -Descending)
    foreach ($d in $dirs) {
        if (@(Get-ChildItem -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue).Count -eq 0) {
            Remove-Item -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue
        }
    }
}

$cached = @()
$toParse = @()
foreach ($f in $files) {
    $parent = Split-Path -Parent $f
    $stem = [IO.Path]::GetFileNameWithoutExtension($f)
    $candidates = @()
    $backMd = Join-Path $parent ($stem + '.md')
    if (Test-Path -LiteralPath $backMd) { $candidates += $backMd }
    if (Test-Path -LiteralPath $OutDir) {
        $mds = @(Get-ChildItem -LiteralPath $OutDir -Recurse -Filter '*.md' -ErrorAction SilentlyContinue)
        foreach ($m in $mds) {
            if ($m.BaseName -eq $stem) { $candidates += $m.FullName }
        }
    }
    $hit = $null
    foreach ($c in ($candidates | Select-Object -Unique)) {
        try {
            if ((Get-Item -LiteralPath $c).LastWriteTime -ge (Get-Item -LiteralPath $f).LastWriteTime) {
                $hit = $c
                break
            }
        }
        catch { }
    }
    if ($hit -and -not $Force) {
        $cached += [pscustomobject]@{ Source = $f; Md = $hit }
        Write-Host ("CACHED`t{0}`t{1}" -f $f, $hit)
    }
    else {
        $toParse += [pscustomobject]@{ Source = $f }
    }
}

$stagingDir = $null
$jobs = @()
$inputPath = $null
if ($toParse.Count -gt 1) {
    $stagingDir = Join-Path $env:TEMP ("mineru_stage_" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null
    $i = 1
    foreach ($job in $toParse) {
        $stageName = ("{0}_{1}" -f $i, [IO.Path]::GetFileName($job.Source))
        $target = Join-Path $stagingDir $stageName
        try { Copy-Item -LiteralPath $job.Source -Destination $target -Force } catch { }
        $job | Add-Member -NotePropertyName StageName -NotePropertyValue $stageName
        $i++
    }
    $inputPath = $stagingDir
    $jobs = $toParse
}
elseif ($toParse.Count -eq 1) {
    $toParse[0] | Add-Member -NotePropertyName StageName -NotePropertyValue ([IO.Path]::GetFileName($toParse[0].Source))
    $jobs = $toParse
    $inputPath = $toParse[0].Source
}

$effectiveBackend = $Backend
$totalPages = 0
foreach ($job in $jobs) { $totalPages += (Get-PageCount $job.Source) }
if ($effectiveBackend -eq 'auto') {
    $effectiveBackend = if ($totalPages -lt 10) { 'pipeline' } else { 'hybrid-engine' }
}
Write-Host ("PAGES`t{0}`tBACKEND={1}" -f $totalPages, $effectiveBackend)
$timeout = 120 + ($totalPages * 5)
Write-Host ("RECOMMENDED_TIMEOUT_SECONDS={0}" -f $timeout)

if ($jobs.Count -gt 0) {
    $mineruArgs = @('-p', $inputPath, '-o', $OutDir, '-b', $effectiveBackend, '-m', $Method)
    if ($NoFormula) { $mineruArgs += @('-f', 'False') }
    if ($effectiveBackend -eq 'pipeline') { $mineruArgs += @('-l', $Lang) }
    if ($effectiveBackend -like 'hybrid*') { $mineruArgs += @('--effort', $Effort) }

    Write-Host ("RUNNING`t{0} -> {1}" -f (($jobs | ForEach-Object { $_.Source }) -join '; '), $OutDir)
    & $mineruBat @mineruArgs
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        Write-Host ("MINERU_ERROR`t{0}" -f $exitCode)
        if ($stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue }
        if ($useTempOut) { Remove-Item -LiteralPath $OutDir -Recurse -Force -ErrorAction SilentlyContinue }
        exit 5
    }

    $keepImages = $KeepImages -or (-not $useTempOut)
    foreach ($job in $jobs) {
        $stem = [IO.Path]::GetFileNameWithoutExtension($job.StageName)
        $md = Find-MdByStem $OutDir $stem
        if (-not $md) {
            Write-Host ("NO_MD`t{0}" -f $job.Source)
            continue
        }
        $stemDir = Join-Path $OutDir $stem
        if ($useTempOut) {
            $destParent = Split-Path -Parent $job.Source
            $dest = Join-Path $destParent ([IO.Path]::GetFileNameWithoutExtension($job.Source) + '.md')
            Copy-Item -LiteralPath $md -Destination $dest -Force
            $md = $dest
            Remove-Item -LiteralPath $stemDir -Recurse -Force -ErrorAction SilentlyContinue
        }
        else {
            Invoke-OutputCleanup $stemDir $keepImages
        }
        $bytes = 0
        $lines = 0
        try {
            $bytes = (Get-Item -LiteralPath $md).Length
            $lines = @(Get-Content -LiteralPath $md -ErrorAction SilentlyContinue).Count
        }
        catch { }
        Write-Host ("RESULT`t{0}`t{1}`t{2}`t{3}" -f $job.Source, $md, $bytes, $lines)
        if ($bytes -lt 1024) { Write-Host ("WARNING_EMPTY`t{0}" -f $job.Source) }
    }
}

if ($stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue }
if ($useTempOut) { Remove-Item -LiteralPath $OutDir -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host ("DONE`tparsed={0}`tcached={1}" -f $jobs.Count, $cached.Count)
exit 0
