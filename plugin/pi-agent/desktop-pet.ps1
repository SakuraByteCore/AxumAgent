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
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

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
    <Border Grid.Row="1" Background="#DE202632" CornerRadius="10"
            Padding="8,4" HorizontalAlignment="Center" VerticalAlignment="Top">
      <TextBlock x:Name="PetLabel" Foreground="White" FontSize="13"
                 TextAlignment="Center" TextWrapping="Wrap" MaxWidth="180"
                 Text="待机 · 双击挥手"/>
    </Border>
  </Grid>
</Window>
'@
$reader = New-Object System.Xml.XmlNodeReader $markup
try { $window = [System.Windows.Markup.XamlReader]::Load($reader) }
finally { $reader.Close() }
$image = $window.FindName('PetImage')
$label = $window.FindName('PetLabel')
$assetRoot = Split-Path -Parent $ImagePath
$atlasSpec = Get-Content -LiteralPath (Join-Path $assetRoot 'desktop-pet-atlas.json') -Raw | ConvertFrom-Json
$bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
$bitmap.BeginInit()
$bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
$bitmap.UriSource = [Uri]::new([System.IO.Path]::GetFullPath((Join-Path $assetRoot 'desktop-pet-atlas.png')))
$bitmap.EndInit()
$bitmap.Freeze()
$frames = @{}
foreach ($entry in $atlasSpec.animations.PSObject.Properties) {
    $frames[$entry.Name] = @()
    for ($i = 0; $i -lt $entry.Value.frames; $i++) {
        $size = [int]$atlasSpec.frameSize
        $rect = [System.Windows.Int32Rect]::new($i * $size, [int]$entry.Value.row * $size, $size, $size)
        $frame = [System.Windows.Media.Imaging.CroppedBitmap]::new($bitmap, $rect)
        $frame.Freeze()
        $frames[$entry.Name] += $frame
    }
}
$image.Source = $frames['idle'][0]

$clock = [System.Diagnostics.Stopwatch]::StartNew()
$script:petState = 'idle'
$script:phaseStart = 0.0
$script:lastTick = 0.0
$script:waveUntil = 0.0
$script:direction = -1.0
$script:dragging = $false
$script:dragPoint = $null
$script:dragLeft = 0.0
$script:dragTop = 0.0
$script:animationsEnabled = $true
$script:source = $null

function Set-PetLabel {
    switch ($script:petState) {
        'working' { $label.Text = '忙碌中 · 努力处理…' }
        'waiting' { $label.Text = '等待确认 · 请查看主窗口' }
        'failed'  { $label.Text = '(╥﹏╥) 沮丧 · 处理失败' }
        default  { $label.Text = '待机 · 双击挥手' }
    }
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
    $script:waveUntil = 0.0
    Set-PetLabel
})
$exitItem = New-Object System.Windows.Controls.MenuItem
$exitItem.Header = '退出宠物'
$exitItem.Add_Click({ $window.Close() })
[void]$menu.Items.Add($animationItem)
[void]$menu.Items.Add($exitItem)
$window.ContextMenu = $menu

# WM_MOUSEACTIVATE 返回 MA_NOACTIVATE，允许鼠标交互而不激活主窗口。
$mouseActivateMessage = 0x0021
$noActivateResult = [IntPtr]3
$hook = [System.Windows.Interop.HwndSourceHook]{
    param([IntPtr]$handle, [int]$message, [IntPtr]$wParam,
          [IntPtr]$lParam, [ref]$handled)
    if ($message -eq $mouseActivateMessage) {
        $handled.Value = $true
        return $noActivateResult
    }
    return [IntPtr]::Zero
}
$window.Add_SourceInitialized({
    $helper = New-Object System.Windows.Interop.WindowInteropHelper $window
    $script:source = [System.Windows.Interop.HwndSource]::FromHwnd($helper.Handle)
    $script:source.AddHook($hook)
})
$window.Add_MouseLeftButtonDown({
    param($sender, $eventArgs)
    if ($eventArgs.ClickCount -eq 2) {
        $script:waveUntil = $clock.Elapsed.TotalSeconds + 1.2
        $label.Text = '挥手～ 你好！'
        $eventArgs.Handled = $true
        return
    }
    $script:dragging = $true
    $script:dragPoint = $window.PointToScreen($eventArgs.GetPosition($window))
    $script:dragLeft = $window.Left
    $script:dragTop = $window.Top
    [void]$window.CaptureMouse()
    $eventArgs.Handled = $true
})
$window.Add_MouseMove({
    param($sender, $eventArgs)
    if (-not $script:dragging) { return }
    $point = $window.PointToScreen($eventArgs.GetPosition($window))
    $delta = [System.Windows.Vector]::new(
        $point.X - $script:dragPoint.X, $point.Y - $script:dragPoint.Y)
    $delta = $script:source.CompositionTarget.TransformFromDevice.Transform($delta)
    $window.Left = $script:dragLeft + $delta.X
    $window.Top = $script:dragTop + $delta.Y
    Limit-PetPosition
})
$window.Add_MouseLeftButtonUp({
    $script:dragging = $false
    $window.ReleaseMouseCapture()
})
$window.Add_LostMouseCapture({ $script:dragging = $false })

function Update-PetMotion {
    param([double]$Now, [double]$Elapsed)
    Set-PetLabel
    $active = $script:animationsEnabled -and [System.Windows.SystemParameters]::ClientAreaAnimation -and
        -not $script:dragging -and -not $menu.IsOpen
    $phase = $Now - $script:phaseStart
    $action = $script:petState
    if ($active -and $Now -lt $script:waveUntil) {
        $action = 'wave'
        $phase = $Now - ($script:waveUntil - 1.2)
        $label.Text = '挥手～ 你好！'
    } elseif ($active -and $action -eq 'idle' -and ($phase % 20) -ge 4 -and ($phase % 20) -le 14) {
        $action = 'walk'
        $window.Left += $script:direction * 7.0 * $Elapsed
        $workArea = [System.Windows.SystemParameters]::WorkArea
        if ($window.Left -le $workArea.Left -or $window.Left + $window.Width -ge $workArea.Right) {
            $script:direction *= -1.0
        }
        Limit-PetPosition
    }
    $spec = $atlasSpec.animations.PSObject.Properties[$action].Value
    $index = 0
    if ($active) { $index = [int][Math]::Floor($phase * $spec.fps) % [int]$spec.frames }
    $image.Source = $frames[$action][$index]
}

$area = [System.Windows.SystemParameters]::WorkArea
$window.Left = [Math]::Max($area.Left, $area.Right - $window.Width - 24.0)
$window.Top = [Math]::Max($area.Top, $area.Bottom - $window.Height - 24.0)
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(83)
$timer.Add_Tick({
    if ($parentProcess.HasExited -or -not [System.IO.File]::Exists($StatePath)) {
        $window.Close()
        return
    }
    $now = $clock.Elapsed.TotalSeconds
    $elapsed = [Math]::Min(0.2, $now - $script:lastTick)
    $script:lastTick = $now
    # TS 写入期间可能读到不完整 JSON；只在读到完整合法状态后切换。
    try {
        $data = [System.IO.File]::ReadAllText($StatePath) | ConvertFrom-Json
        if ($data.state -in @('idle', 'working', 'waiting', 'failed') -and
            $data.state -ne $script:petState) {
            $script:petState = [string]$data.state
            $script:phaseStart = $now
            $script:waveUntil = 0.0
                    Set-PetLabel
        }
    } catch {
        # 文件读取竞争或未完成的 JSON 不改变上一次状态。
    }
    Update-PetMotion -Now $now -Elapsed $elapsed
})
$window.Add_Closed({
    $timer.Stop()
    $clock.Stop()
    $script:dragging = $false
    if ($null -ne $script:source) { $script:source.RemoveHook($hook) }
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
