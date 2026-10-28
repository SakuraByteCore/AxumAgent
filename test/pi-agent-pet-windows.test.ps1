# 默认实际 WPF 路由事件；-SystemInput 为独占桌面人工辅助运行，不作为默认验收。
param([switch]$SystemInput)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$temp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
[void][IO.Directory]::CreateDirectory($temp)
$state = Join-Path $temp 'state.json'
[IO.File]::WriteAllText($state, '{"state":"idle"}')
$code = [IO.File]::ReadAllText((Join-Path $root 'plugin/pi-agent/desktop-pet.ps1'))
$probe = @'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class PetInput {
 public struct Point { public int X; public int Y; }
 [DllImport("user32.dll")] public static extern bool GetPhysicalCursorPos(out Point p);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll", SetLastError=true)] public static extern bool SetPhysicalCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,int m,IntPtr w,IntPtr l);
}
"@
function Check($condition, $name) { if (-not $condition) { throw "FAIL: $name" }; [Console]::WriteLine("PASS: $name") }
function Pump {
 $f=New-Object Windows.Threading.DispatcherFrame
 $t=New-Object Windows.Threading.DispatcherTimer
 $t.Interval=[TimeSpan]::FromMilliseconds(45)
 $t.Add_Tick({ $f.Continue=$false }.GetNewClosure()); $t.Start()
 [Windows.Threading.Dispatcher]::PushFrame($f); $t.Stop()
}
function Cursor($x,$y) {
 $point=$window.PointToScreen([Windows.Point]::new($x,$y))
 $moved=[PetInput]::SetPhysicalCursorPos([int]$point.X,[int]$point.Y); Pump
 $actual=New-Object PetInput+Point; [void][PetInput]::GetPhysicalCursorPos([ref]$actual)
 [Console]::WriteLine("pointer moved=$moved expected=$point actual=$($actual.X),$($actual.Y) hwnd=$([PetInput]::WindowFromPoint($actual)) pet=$($script:source.Handle) alpha=$(Test-PetHit ([Windows.Point]::new($x,$y)))")
}
function Button($event, $count) {
 $flag=4; if ($event -eq [Windows.UIElement]::MouseLeftButtonDownEvent) { $flag=2 }
 [PetInput]::mouse_event($flag,0,0,0,[UIntPtr]::Zero); Pump
}
function Down { Button ([Windows.UIElement]::MouseLeftButtonDownEvent) 1 }
function Up { Button ([Windows.UIElement]::MouseLeftButtonUpEvent) 1 }
function Move-PetPointer { Pump }
$script:step=-6
$script:testFailed=$false
$script:seenExpressions=@{}
$timer.Add_Tick({ $script:seenExpressions[$script:expressionKey]=$true })
$probeTimer=New-Object Windows.Threading.DispatcherTimer
$probeTimer.Interval=[TimeSpan]::FromMilliseconds(700)
$probeTimer.Add_Tick({
 # Pump nests the dispatcher; do not re-enter this sequence before its step completes.
 $probeTimer.Stop()
 try {
  switch ($script:step) {
   -3 { Cursor 145 55; Move-PetPointer }
   -2 {
    Check ($gaze.X -gt 0 -and $gaze.Y -lt 0) 'mouse input smooth two-axis head response'
    $headX=$gaze.X; $headY=$gaze.Y; $moving=$script:frame
    $gaze.X=0; $gaze.Y=0; Set-PetComposite $script:frameAction $script:frameIndex
    $neutral=New-Object byte[] (160*160*4); $pixels=New-Object byte[] $neutral.Length
    $script:frame.CopyPixels($neutral,640,0); $moving.CopyPixels($pixels,640,0)
    $headChanged=$false; $bodySame=$true
    for ($i=0;$i -lt $pixels.Length;$i++) {
     if ($i -lt 90*640 -and $pixels[$i] -ne $neutral[$i]) { $headChanged=$true }
     if ($i -ge 110*640 -and $pixels[$i] -ne $neutral[$i]) { $bodySame=$false }
    }
    Check ($headChanged -and $bodySame) 'only head changes; lower body byte identical'
    $gaze.X=$headX; $gaze.Y=$headY; Set-PetComposite $script:frameAction $script:frameIndex
    $script:frame.CopyPixels($pixels,640,0)
    foreach ($y in @(10,40,80,110,150)) { for ($x=0;$x -lt 160;$x++) {
     $point=$image.TranslatePoint([Windows.Point]::new($x+.5,$y+.5),$window)
     if ((Test-PetHit $point) -ne ($pixels[($y*160+$x)*4+3] -gt 24)) { throw 'composite alpha hit mismatch' }
    }}
    Check $true 'transformed composite alpha matches hit route'
    Cursor 60 120; Move-PetPointer
   }
   -1 { Check ($gaze.X -lt 0 -and $gaze.Y -gt 0) 'opposite pointer reverses both head axes'; $script:patrolX=$window.Left }
   0 {
    Check ($window.Left -lt $script:patrolX -and $script:frameAction -eq 'walk') 'HEAD idle patrol restored'
    Check ($caption.Opacity -lt .02) 'idle caption hidden'
    Check ($window.Topmost -and $window.AllowsTransparency) 'transparent topmost window'
    Check ($image.Stretch -eq 'Uniform' -and $image.ActualWidth -eq $image.ActualHeight) 'uniform sprite aspect'
    Check (Test-PetHit ([Windows.Point]::new(100,80))) 'opaque alpha hit'
    Check (-not (Test-PetHit ([Windows.Point]::new(1,1)))) 'transparent alpha miss'
    $p=$window.PointToScreen([Windows.Point]::new(1,1))
    $packed=([int]$p.Y -shl 16) -bor ([int]$p.X -band 65535)
    $hit=[PetInput]::SendMessage($script:source.Handle,0x84,[IntPtr]::Zero,[IntPtr]$packed).ToInt64()
    [Console]::WriteLine("Native hit result: $hit")
    Check ($hit -eq -1 -or $hit -eq 4294967295) 'native transparent hit test'
    Cursor 100 115; Down; Up
   }
   1 { [Console]::WriteLine("click action=$script:action pending=$script:pendingClick opacity=$($caption.Opacity) now=$($clock.Elapsed.TotalSeconds) until=$script:actionUntil state=$script:petState active=$($window.IsActive)"); Check ($script:action -eq 'happy' -and $caption.Opacity -gt .2) 'single click feedback'; Cursor 100 115; Down; Up; Button ([Windows.UIElement]::MouseLeftButtonDownEvent) 2; Up }
   2 { Check ($script:action -eq 'wave' -and $script:frameAction -eq 'wave') 'double click real wave'; Cursor 100 115; Down }
   4 { Check ($script:longPressed -and $script:action -eq 'rest') 'hold special feedback'; Up }
   5 { Check ($script:pendingClick -eq 0) 'hold excludes click' }
   6 { Cursor 100 115; Down; $script:patrolX=$window.Left }
   7 { Check ($window.Left -eq $script:patrolX) 'press blocks patrol'; Cursor 65 95; Move-PetPointer; $script:patrolX=$window.Left }
   8 { Check ($window.Left -eq $script:patrolX) 'drag owns position'; Check $script:dragging 'drag threshold'; Up; Check ($script:pendingClick -eq 0) 'drag excludes click'; [IO.File]::WriteAllText($StatePath,'{"state":"working"}') }
   9 { Check ($script:petState -eq 'working' -and $label.Text -eq '正在处理任务…') 'working consumer'; [IO.File]::WriteAllText($StatePath,'{"state":"waiting"}') }
   10 { Check ($script:petState -eq 'waiting') 'waiting consumer'; [IO.File]::WriteAllText($StatePath,'{"state":"failed"}') }
   11 { Check ($script:petState -eq 'failed') 'error consumer'; [IO.File]::WriteAllText($StatePath,'{"state":') }
   12 { Check ($script:petState -eq 'failed') 'partial JSON preserves state'; [IO.File]::WriteAllText($StatePath,'{"state":"idle"}') }
   13 { Check ($script:petState -eq 'idle') 'recovery'; Cursor 100 115; Down; $window.WindowState='Minimized' }
   14 { Check ($null -eq $script:pressPoint) 'minimize cancels gesture'; Up; $window.WindowState='Normal' }
   15 {
    Check ($caption.Opacity -lt .02) 'caption fades out after recovery'
    foreach ($dpi in @(96,144,192)) {
     $render=[Windows.Media.Imaging.RenderTargetBitmap]::new([int](200*$dpi/96),[int](230*$dpi/96),$dpi,$dpi,[Windows.Media.PixelFormats]::Pbgra32)
     $render.Render($window)
     Check ($render.PixelWidth -eq [int](200*$dpi/96)) "DPI render $dpi"
    }
    [IO.File]::WriteAllText($StatePath,'{"state":"thinking"}')
   }
   16 { Check ($label.Text -eq '正在思考…') 'thinking consumer'; [IO.File]::WriteAllText($StatePath,'{"state":"replying"}') }
   17 { Check ($label.Text -eq '正在回复…') 'reply consumer'; Cursor 100 115; Down; $window.ReleaseMouseCapture() }
   18 { Check ($null -eq $script:pressPoint) 'capture loss cancels hold'; Up; [IO.File]::WriteAllText($StatePath,'{"state":"idle"}') }
   24 { Check ($script:frameAction -eq 'walk') 'state recovery resumes patrol'; $animationItem.IsChecked=$false; $animationItem.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.MenuItem]::ClickEvent)); $script:patrolX=$window.Left }
   25 { Check ($window.Left -eq $script:patrolX) 'pause stops patrol'; Check ($script:expressionKey -eq '0:0' -and $null -eq $script:blinkAt) 'pause clears expression deadline'; $animationItem.IsChecked=$true; $animationItem.RaiseEvent([Windows.RoutedEventArgs]::new([Windows.Controls.MenuItem]::ClickEvent)) }
   26 { Check ($window.Left -lt $script:patrolX) 'resume restarts patrol'; $window.WindowState='Minimized'; $script:patrolX=$window.Left }
   27 { Check ($window.Left -eq $script:patrolX) 'minimize stops patrol'; Check ($script:expressionKey -eq '0:0' -and $null -eq $script:blinkAt) 'minimize clears expression deadline'; $window.WindowState='Normal' }
   28 { Check ($window.Left -lt $script:patrolX -and $script:pendingClick -eq 0) 'restore patrol without late click'; Check ($script:expressionTime -lt 1 -and $script:blinkAt -gt $script:expressionTime) 'restore schedules fresh blink' }
   39 {
    Check (@($script:seenExpressions.Keys | Where-Object { $_ -like '2:*' }).Count -gt 0) 'real timer random blink'
    Check ($script:seenExpressions.ContainsKey("0:$(-$expressionSpec.swaySteps)") -and $script:seenExpressions.ContainsKey("0:$($expressionSpec.swaySteps)")) 'real timer hood sway both directions'
    [IO.File]::Delete($StatePath)
   }
   41 { throw 'consumer failed to exit after state removal' }
  }
  $script:step++
  if ($window.IsVisible) { $probeTimer.Start() }
 } catch { [Console]::WriteLine($_.ToString()); $script:testFailed=$true; $window.Close() }
})
$window.Left=100; $window.Top=100
$probeTimer.Start()
[void]$application.Run($window)
$probeTimer.Stop()
Check (-not $timer.IsEnabled -and $null -eq $script:pressPoint -and $null -eq [PetNativeHitTest]::Hit) 'real Closed handler cleanup'
Check ($script:expressionKey -eq '0:0' -and $null -eq $script:blinkAt) 'Closed clears expression deadline'
if ($script:testFailed) { throw 'Windows interaction probe failed' }
'@
if (-not $SystemInput) {
 $start=$probe.IndexOf('function Cursor('); $end=$probe.IndexOf('$script:step=-6')
 $routed=@'
function Cursor($x,$y) { $script:probePoint=[Windows.Point]::new($x,$y) }
function Button($event, $count) {
 $e=New-Object Windows.Input.MouseButtonEventArgs ([Windows.Input.Mouse]::PrimaryDevice),0,([Windows.Input.MouseButton]::Left)
 $e.RoutedEvent=$event; $script:probeCount=$count
 $window.RaiseEvent($e); Pump
}
function Down { Button ([Windows.UIElement]::MouseLeftButtonDownEvent) 1 }
function Up { Button ([Windows.UIElement]::MouseLeftButtonUpEvent) 1 }
function Move-PetPointer {
 $e=New-Object Windows.Input.MouseEventArgs ([Windows.Input.Mouse]::PrimaryDevice),0
 $e.RoutedEvent=[Windows.UIElement]::MouseMoveEvent
 $window.RaiseEvent($e); Pump
}
'@
 $probe=$probe.Substring(0,$start)+$routed+"`n"+$probe.Substring($end)
 # 仅替换输入采样；真实处理器、定时器、状态文件与关闭链保持原样。
 $code=$code.Replace('$eventArgs.GetPosition($window)', '$script:probePoint').Replace('$eventArgs.ClickCount', '$script:probeCount')
}
$code = $code.Replace('[void]$application.Run($window)', $probe)
$scriptFile = Join-Path $temp 'pet-probe.ps1'
[IO.File]::WriteAllText($scriptFile, $code, [Text.UTF8Encoding]::new($true))
try {
 & $scriptFile -StatePath $state -ImagePath (Join-Path $root 'plugin/pi-agent/assets/desktop-pet.png') -ParentProcessId $PID
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
