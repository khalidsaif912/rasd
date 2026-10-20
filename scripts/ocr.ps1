param([Parameter(Mandatory = $true)][string]$Folder)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1"
})[0]

function Await-Op($operation, $type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    $task.Wait() | Out-Null
    if ($task.IsFaulted) { throw $task.Exception }
    return $task.Result
}

function Recognize($path, $tag) {
    $file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await-Op ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await-Op ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await-Op ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    if ($bitmap.BitmapPixelFormat -ne [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8 -or $bitmap.BitmapAlphaMode -ne [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied) {
        $bitmap = [Windows.Graphics.Imaging.SoftwareBitmap]::Convert($bitmap, [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)
    }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $tag))
    if (-not $engine) { return "" }
    $result = Await-Op ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
    $rows = New-Object System.Collections.Generic.List[object]
    foreach ($line in $result.Lines) {
        $words = @($line.Words)
        if ($words.Count -eq 0) { continue }
        $blob = ($words | ForEach-Object { $_.Text }) -join ""
        $arabic = $blob -match "[\u0600-\u06FF]"
        $ordered = if ($arabic) { $words | Sort-Object { $_.BoundingRect.X } -Descending } else { $words | Sort-Object { $_.BoundingRect.X } }
        $rows.Add([pscustomobject]@{
            Y = [double]$words[0].BoundingRect.Y
            Text = (($ordered | ForEach-Object { $_.Text }) -join " ")
        })
    }
    return (($rows | Sort-Object Y | ForEach-Object { $_.Text }) -join "`n")
}

$parts = New-Object System.Collections.Generic.List[string]
Get-ChildItem -Path $Folder -Filter *.png | Sort-Object Name | ForEach-Object {
    $arabic = Recognize $_.FullName "ar-SA"
    $english = Recognize $_.FullName "en-US"
    $arabicCount = ([regex]::Matches($arabic, "[\u0600-\u06FF]")).Count
    $latinCount = ([regex]::Matches($english, "[A-Za-z]")).Count
    if ($arabicCount -ge 2 -and $arabicCount -ge $latinCount) {
        $parts.Add($arabic)
    } elseif ($latinCount -ge 3) {
        $parts.Add($english)
    } else {
        $parts.Add($arabic)
    }
}
$target = Join-Path $Folder "ocr.txt"
[System.IO.File]::WriteAllText($target, ($parts -join "`n---`n"), [System.Text.UTF8Encoding]::new($false))
