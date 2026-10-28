param(
    [Parameter(Mandatory = $true)][string]$StatePath,
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][int]$ParentProcessId
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { exit }
try { $parentProcess = [System.Diagnostics.Process]::GetProcessById($ParentProcessId) }
catch { exit }
if ($parentProcess.HasExited) { $parentProcess.Dispose(); exit }
if ([System.Threading.Thread]::CurrentThread.ApartmentState -ne 'STA') {
    throw '桌面宠物需要 STA 线程，请使用 powershell.exe -STA -File 启动。'
}
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

# 固定 XAML 不插入路径或状态内容；原图仅通过 BitmapImage 读取。
[xml]$markup = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Width="200" Height="230" WindowStyle="None" AllowsTransparency="True"
        Background="Transparent" Topmost="True" ShowInTaskbar="False"
        ShowActivated="False" ResizeMode="NoResize" Focusable="False"
        Title="桌面宠物">
  <Grid Background="Transparent">
    <Grid.RowDefinitions>
      <RowDefinition Height="180"/>
      <RowDefinition Height="50"/>
    </Grid.RowDefinitions>
    <Image x:Name="PetImage" Width="160" Height="160" Stretch="Uniform"
           IsHitTestVisible="False"/>
    <Border x:Name="PetCaption" Grid.Row="1" Opacity="0" IsHitTestVisible="False" Background="#EEFFF8F3" CornerRadius="14"
            Padding="8,4" HorizontalAlignment="Center" VerticalAlignment="Top">
      <TextBlock x:Name="PetLabel" Foreground="#654F49" FontSize="12"
                 TextAlignment="Center" TextWrapping="NoWrap" TextTrimming="CharacterEllipsis" MaxWidth="174"
                 Text=""/>
    </Border>
  </Grid>
</Window>
'@
$reader = New-Object System.Xml.XmlNodeReader $markup
try { $window = [System.Windows.Markup.XamlReader]::Load($reader) }
finally { $reader.Close() }
$image = $window.FindName('PetImage')
$label = $window.FindName('PetLabel')
$caption = $window.FindName('PetCaption')
$gaze = New-Object System.Windows.Media.TranslateTransform
$assetRoot = Split-Path -Parent $ImagePath
$motionRoot = Join-Path $assetRoot 'desktop-pet-motion'
$motionSpec = Get-Content -LiteralPath (Join-Path $motionRoot 'motion.json') -Raw | ConvertFrom-Json
$atlasSpec = Get-Content -LiteralPath (Join-Path $assetRoot 'desktop-pet-atlas.json') -Raw | ConvertFrom-Json
$bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
$bitmap.BeginInit()
$bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
$bitmap.UriSource = [Uri]::new([System.IO.Path]::GetFullPath((Join-Path $motionRoot 'body.png')))
$bitmap.EndInit()
$bitmap.Freeze()
$headBitmap = New-Object System.Windows.Media.Imaging.BitmapImage
$headBitmap.BeginInit()
$headBitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
$headBitmap.UriSource = [Uri]::new([System.IO.Path]::GetFullPath((Join-Path $motionRoot 'head.png')))
$headBitmap.EndInit()
$headBitmap.Freeze()
$frames = @{}
$headFrames = @{}
foreach ($entry in $atlasSpec.animations.PSObject.Properties) {
    $frames[$entry.Name] = @()
    $headFrames[$entry.Name] = @()
    for ($i = 0; $i -lt $entry.Value.frames; $i++) {
        $size = [int]$atlasSpec.frameSize
        $rect = [System.Windows.Int32Rect]::new($i * $size, [int]$entry.Value.row * $size, $size, $size)
        $frame = [System.Windows.Media.Imaging.CroppedBitmap]::new($bitmap, $rect)
        $frame.Freeze()
        $frames[$entry.Name] += $frame
        $headFrame = [System.Windows.Media.Imaging.CroppedBitmap]::new($headBitmap, $rect)
        $headFrame.Freeze()
        $headFrames[$entry.Name] += $headFrame
    }
}
$expressionRoot = Join-Path $assetRoot 'desktop-pet-expression'
$expressionSpec = Get-Content -LiteralPath (Join-Path $expressionRoot 'expression.json') -Raw | ConvertFrom-Json
$expressionFrames = @{}
foreach ($entry in $expressionSpec.variants.PSObject.Properties) {
    $sheet = New-Object System.Windows.Media.Imaging.BitmapImage
    $sheet.BeginInit()
    $sheet.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $sheet.UriSource = [Uri]::new([System.IO.Path]::GetFullPath((Join-Path $expressionRoot $entry.Value.file)))
    $sheet.EndInit(); $sheet.Freeze()
    $cells = @()
    $size = [int]$expressionSpec.frameSize
    for ($x = 0; $x -lt $sheet.PixelWidth; $x += $size) {
        $cell = [System.Windows.Media.Imaging.CroppedBitmap]::new($sheet, [System.Windows.Int32Rect]::new($x,0,$size,$size))
        $cell.Freeze(); $cells += $cell
    }
    $expressionFrames[$entry.Name] = $cells
}
$expressionRandom = New-Object System.Random
function Reset-PetExpression {
    $script:expressionTime = 0.0
    $script:blinkAt = $null
    $script:expressionKey = '0:0'
}
function Update-PetExpression([double]$Elapsed, [bool]$Active) {
    if (-not $Active) { Reset-PetExpression; return }
    $script:expressionTime += $Elapsed
    if ($null -eq $script:blinkAt) {
        $script:blinkAt = $script:expressionTime + $expressionSpec.blinkInterval[0] +
            $expressionRandom.NextDouble()*($expressionSpec.blinkInterval[1]-$expressionSpec.blinkInterval[0])
    }
    $phase = ($script:expressionTime-$script:blinkAt)/$expressionSpec.blinkSeconds
    $blink = 0
    if ($phase -ge 1) { $script:blinkAt = $null }
    elseif ($phase -ge 0) {
        $blink = 1
        if ($phase -ge $expressionSpec.blinkHold[0] -and $phase -le $expressionSpec.blinkHold[1]) { $blink = 2 }
    }
    $wave = [Math]::Sin(2*[Math]::PI*$script:expressionTime/$expressionSpec.swayPeriod)
    $sway = [int][Math]::Round($wave*$expressionSpec.swaySteps)
    $script:expressionKey = "${blink}:$sway"
}
Reset-PetExpression
function Set-PetComposite([string]$Action, [int]$Index) {
    $key = "$Action/$Index/$($gaze.X)/$($gaze.Y)/$script:expressionKey"
    if ($key -eq $script:compositeKey) { return }
    $size = [double]$motionSpec.frameSize
    $visual = New-Object System.Windows.Media.DrawingVisual
    $drawing = $visual.RenderOpen()
    $drawing.PushTransform([System.Windows.Media.ScaleTransform]::new($image.Width/$size, $image.Height/$size))
    $rect = [System.Windows.Rect]::new(0,0,$size,$size)
    $drawing.DrawImage($frames[$Action][$Index], $rect)
    $matrix = [System.Windows.Media.Matrix]::Identity
    $matrix.RotateAt($gaze.X*$motionSpec.rotationPerX, $motionSpec.pivot[0], $motionSpec.pivot[1])
    $matrix.Translate($gaze.X*$motionSpec.translationScale, $gaze.Y*$motionSpec.translationScale)
    $drawing.PushTransform([System.Windows.Media.MatrixTransform]::new($matrix))
    $head = $headFrames[$Action][$Index]
    if ($script:expressionKey -ne '0:0') {
        $variant = $expressionSpec.variants.PSObject.Properties[$script:expressionKey].Value
        $cell = [int]$variant.frames.PSObject.Properties[$Action].Value[$Index]
        $head = $expressionFrames[$script:expressionKey][$cell]
    }
    $drawing.DrawImage($head, $rect)
    $drawing.Pop(); $drawing.Pop(); $drawing.Close()
    $script:frame = [System.Windows.Media.Imaging.RenderTargetBitmap]::new([int]$image.Width,[int]$image.Height,96,96,[System.Windows.Media.PixelFormats]::Pbgra32)
    $script:frame.Render($visual)
    $script:frame.Freeze()
    $image.Source = $script:frame
    $script:frameAction = $Action
    $script:frameIndex = $Index
    $script:compositeKey = $key
}
Set-PetComposite 'idle' 0

# One dispatcher owns gesture deadlines, local feedback and frame selection.
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$script:petState = 'idle'
$script:phaseStart = 0.0
$script:lastTick = 0.0
$script:direction = -1.0
$patrolSpeed = 7.0
$patrolPeriod = 20.0
$patrolStart = 4.0
$patrolEnd = 14.0
$script:action = ''
$script:actionStart = 0.0
$script:actionUntil = 0.0
$script:pendingClick = 0.0
$script:pressedAt = 0.0
$script:pressPoint = $null
$script:dragging = $false
$script:longPressed = $false
$script:doublePressed = $false
$script:dragLeft = 0.0
$script:dragTop = 0.0
$script:animationsEnabled = $true
$script:source = $null
$script:gazeX = 0.0
$script:gazeY = 0.0
$script:lastLabel = ''
$script:nextStateRead = 0.0
$statePollSeconds = 0.1

function Reset-PetGesture {
    Reset-PetExpression
    $script:pressPoint = $null
    $script:dragging = $false
    $script:pendingClick = 0.0
    $window.ReleaseMouseCapture()
}
function Start-PetAction([string]$Action, [double]$Now) {
    $script:action = $Action
    $script:actionStart = $Now
    $script:actionUntil = $Now + 1.6
}
function Test-PetHit([System.Windows.Point]$Point) {
    # Alpha of the actual displayed sprite, not its rectangular Image control.
    $local = $window.TranslatePoint($Point, $image)
    $x = [int][Math]::Floor($local.X * $script:frame.PixelWidth / $image.ActualWidth)
    $y = [int][Math]::Floor($local.Y * $script:frame.PixelHeight / $image.ActualHeight)
    if ($x -lt 0 -or $y -lt 0 -or $x -ge $script:frame.PixelWidth -or $y -ge $script:frame.PixelHeight) { return $false }
    $pixel = New-Object byte[] 4
    $script:frame.CopyPixels([System.Windows.Int32Rect]::new($x,$y,1,1), $pixel, 4, 0)
    return $pixel[3] -gt 24
}

function Limit-PetPosition {
    $area = [System.Windows.SystemParameters]::WorkArea
    $maxLeft = [Math]::Max($area.Left, $area.Right - $window.Width)
    $maxTop = [Math]::Max($area.Top, $area.Bottom - $window.Height)
    $window.Left = [Math]::Max($area.Left, [Math]::Min($maxLeft, $window.Left))
    $window.Top = [Math]::Max($area.Top, [Math]::Min($maxTop, $window.Top))
}

$menu = New-Object System.Windows.Controls.ContextMenu
$menu.Focusable = $false
$animationItem = New-Object System.Windows.Controls.MenuItem
$animationItem.Header = '开启动画（遵循系统设置）'
$animationItem.IsCheckable = $true
$animationItem.IsChecked = $true
$animationItem.Add_Click({
    $script:animationsEnabled = [bool]$animationItem.IsChecked
    Reset-PetGesture
    $script:actionUntil = 0.0
})
$exitItem = New-Object System.Windows.Controls.MenuItem
$exitItem.Header = '退出宠物'
$exitItem.Add_Click({ $window.Close() })
[void]$menu.Items.Add($animationItem)
[void]$menu.Items.Add($exitItem)
$window.ContextMenu = $menu

# Native hit testing lets transparent pixels pass through to other applications.
# PowerShell delegate ref-bool does not reliably propagate HwndSourceHook.handled.
# Keep that boundary in C#; the displayed-frame alpha decision stays in PowerShell.
Add-Type -ReferencedAssemblies WindowsBase, PresentationCore -TypeDefinition @'
using System;
using System.Windows.Interop;
public static class PetNativeHitTest {
    public static Func<int,int,bool> Hit;
    public static readonly HwndSourceHook Callback = Hook;
    public static IntPtr Hook(IntPtr hwnd, int msg, IntPtr w, IntPtr l, ref bool handled) {
        if (msg == 0x21) { handled = true; return new IntPtr(3); }
        if (msg == 0x84 && Hit != null) {
            long p = l.ToInt64();
            if (!Hit((short)(p & 65535), (short)((p >> 16) & 65535))) {
                handled = true; return new IntPtr(-1);
            }
        }
        return IntPtr.Zero;
    }
}
'@
[PetNativeHitTest]::Hit = [Func[int,int,bool]]{
    param($x,$y)
    if ($null -ne $script:pressPoint) { return $true }
    return Test-PetHit ($window.PointFromScreen([System.Windows.Point]::new($x,$y)))
}
$hook = [PetNativeHitTest]::Callback
$window.Add_SourceInitialized({
    $helper = New-Object System.Windows.Interop.WindowInteropHelper $window
    $script:source = [System.Windows.Interop.HwndSource]::FromHwnd($helper.Handle)
    $script:source.AddHook($hook)
})
$window.Add_MouseLeftButtonDown({
    param($sender, $eventArgs)
    if (-not (Test-PetHit ($eventArgs.GetPosition($window)))) { return }
    $now = $clock.Elapsed.TotalSeconds
    $script:doublePressed = $eventArgs.ClickCount -eq 2 -and $script:pendingClick -gt 0
    $script:pendingClick = 0.0
    $script:pressedAt = $now
    $script:longPressed = $false
    $script:pressPoint = $window.PointToScreen($eventArgs.GetPosition($window))
    $script:dragLeft = $window.Left; $script:dragTop = $window.Top
    [void]$window.CaptureMouse()
    $eventArgs.Handled = $true
})
$window.Add_MouseMove({
    param($sender, $eventArgs)
    $local = $eventArgs.GetPosition($window)
    $script:gazeX = [Math]::Max(-1.5, [Math]::Min(1.5, ($local.X - 100) / 40))
    $script:gazeY = [Math]::Max(-0.8, [Math]::Min(0.8, ($local.Y - 90) / 90))
    if ($null -eq $script:pressPoint) { return }
    $point = $window.PointToScreen($local)
    $delta = [System.Windows.Vector]::new($point.X - $script:pressPoint.X, $point.Y - $script:pressPoint.Y)
    $delta = $script:source.CompositionTarget.TransformFromDevice.Transform($delta)
    if (-not $script:dragging -and $delta.Length -lt 5) { return }
    $script:dragging = $true
    $script:actionUntil = 0.0
    $window.Left = $script:dragLeft + $delta.X
    $window.Top = $script:dragTop + $delta.Y
    Limit-PetPosition
})
$window.Add_MouseLeftButtonUp({
    param($sender, $eventArgs)
    if ($null -eq $script:pressPoint) { return }
    $now = $clock.Elapsed.TotalSeconds
    if (-not $script:dragging -and -not $script:longPressed) {
        if ($script:doublePressed) { Start-PetAction 'wave' $now }
        else { $script:pendingClick = $now + [System.Windows.Forms.SystemInformation]::DoubleClickTime / 1000.0 }
    }
    $script:pressPoint = $null
    $script:dragging = $false
    $window.ReleaseMouseCapture()
})
$window.Add_LostMouseCapture({
    if ($null -ne $script:pressPoint) { Reset-PetGesture; $script:actionUntil = 0.0 }
})
$window.Add_MouseLeave({ $script:gazeX = 0.0; $script:gazeY = 0.0 })
$window.Add_Deactivated({ Reset-PetGesture; $script:actionUntil = 0.0 })
$menu.Add_Opened({ Reset-PetGesture; $script:actionUntil = 0.0 })
$window.Add_StateChanged({
    Reset-PetGesture; $script:actionUntil = 0.0
    $interval = 33; if ($window.WindowState -eq 'Minimized') { $interval = 100 }
    $timer.Interval = [TimeSpan]::FromMilliseconds($interval)
})

function Update-PetMotion {
    param([double]$Now, [double]$Elapsed)
    $active = $script:animationsEnabled -and [System.Windows.SystemParameters]::ClientAreaAnimation -and
        -not $script:dragging -and -not $menu.IsOpen -and $window.WindowState -ne 'Minimized'
    Update-PetExpression $Elapsed ($active -and $null -eq $script:pressPoint)
    if ($script:pendingClick -gt 0 -and $Now -ge $script:pendingClick) {
        $script:pendingClick = 0.0
        Start-PetAction 'happy' $Now
    }
    if ($null -ne $script:pressPoint -and -not $script:dragging -and -not $script:longPressed -and
        -not $script:doublePressed -and $Now - $script:pressedAt -ge 0.65) {
        $script:longPressed = $true
        Start-PetAction 'rest' $Now
    }
    $action = switch ($script:petState) {
        'thinking' { 'waiting' }
        'replying' { 'working' }
        default { $script:petState }
    }
    $phase = $Now - $script:phaseStart
    $text = switch ($script:petState) {
        'working' { '正在处理任务…' }
        'thinking' { '正在思考…' }
        'replying' { '正在回复…' }
        'waiting' { '等你确认 · 请看主窗口' }
        'failed' { '任务遇到问题 · 请看主窗口' }
        default { '' }
    }
    if ($Now -lt $script:actionUntil) {
        $phase = $Now - $script:actionStart
        switch ($script:action) {
            'wave' { $action = 'wave'; if ($script:petState -eq 'idle') { $text = '你好呀～ 很高兴见到你' } }
            'happy' { $action = 'idle'; if ($script:petState -eq 'idle') { $text = '我在呢，陪着你！' } }
            'rest' { $action = 'waiting'; if ($script:petState -eq 'idle') { $text = '靠一会儿～ 慢慢来' } }
        }
    } elseif ($active -and $action -eq 'idle' -and $null -eq $script:pressPoint -and
        $script:pendingClick -eq 0 -and ($phase % $patrolPeriod) -ge $patrolStart -and
        ($phase % $patrolPeriod) -le $patrolEnd) {
        $action = 'walk'
        $window.Left += $script:direction * $patrolSpeed * $Elapsed
        $workArea = [System.Windows.SystemParameters]::WorkArea
        if ($window.Left -le $workArea.Left -or $window.Left + $window.Width -ge $workArea.Right) {
            $script:direction *= -1.0
        }
        Limit-PetPosition
    }
    $label.Text = $text
    $targetOpacity = 0.0; if ($text) { $targetOpacity = 1.0 }
    # Keep outgoing text during fade-out; the next visible caption replaces it.
    if (-not $text) { $label.Text = $script:lastLabel } else { $script:lastLabel = $text }
    $caption.Opacity += ($targetOpacity - $caption.Opacity) * [Math]::Min(1, $Elapsed * 9)
    $spec = $atlasSpec.animations.PSObject.Properties[$action].Value
    $index = 0
    if ($active) { $index = [int][Math]::Floor($phase * $spec.fps) % [int]$spec.frames }
    $targetX = 0.0; $targetY = 0.0
    if ($active) { $targetX = $script:gazeX; $targetY = $script:gazeY }
    $gaze.X += ($targetX - $gaze.X) * [Math]::Min(1, $Elapsed * 8)
    $gaze.Y += ($targetY - $gaze.Y) * [Math]::Min(1, $Elapsed * 8)
    Set-PetComposite $action $index
}

$area = [System.Windows.SystemParameters]::WorkArea
$window.Left = [Math]::Max($area.Left, $area.Right - $window.Width - 24.0)
$window.Top = [Math]::Max($area.Top, $area.Bottom - $window.Height - 24.0)
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(33)
$timer.Add_Tick({
    if ($parentProcess.HasExited -or -not [System.IO.File]::Exists($StatePath)) {
        $window.Close()
        return
    }
    $now = $clock.Elapsed.TotalSeconds
    $elapsed = [Math]::Min(0.2, $now - $script:lastTick)
    $script:lastTick = $now
    # TS 写入期间可能读到不完整 JSON；只在读到完整合法状态后切换。
    if ($now -ge $script:nextStateRead) {
      $script:nextStateRead = $now + $statePollSeconds
      try {
        $data = [System.IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
        if ($data.state -in @('idle', 'working', 'thinking', 'replying', 'waiting', 'failed') -and
            $data.state -ne $script:petState) {
            $script:petState = [string]$data.state
            $script:phaseStart = $now
            $script:actionUntil = 0.0
            Reset-PetGesture
        }
      } catch {
        # 文件读取竞争或未完成的 JSON 不改变上一次状态。
      }
    }
    if ($window.WindowState -ne 'Minimized') { Update-PetMotion -Now $now -Elapsed $elapsed }
})
$window.Add_Closed({
    $timer.Stop()
    $clock.Stop()
    Reset-PetGesture
    if ($null -ne $script:source) { $script:source.RemoveHook($hook) }
    [PetNativeHitTest]::Hit = $null
})
$application = New-Object System.Windows.Application
$application.ShutdownMode = [System.Windows.ShutdownMode]::OnMainWindowClose
try {
    $timer.Start()
    [void]$application.Run($window)
} finally {
    $timer.Stop()
    $clock.Stop()
    $parentProcess.Dispose()
}
