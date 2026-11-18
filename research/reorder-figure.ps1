# Rebuild the chart from the paired CI samples on Windows PowerShell.
param(
  [string]$Results = (Join-Path $PSScriptRoot 'REORDER-RESULTS.json'),
  [string]$Output = (Join-Path $PSScriptRoot 'reorder-knee.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms.DataVisualization
$report = Get-Content -Raw -LiteralPath $Results | ConvertFrom-Json
$jobs = @($report.jobs | Where-Object { $_.job -eq 'runtime' })
$widths = @(512, 1024, 2048, 4096, 8192)
$cpuNames = @{
  '44304013295' = 'Xeon 8573C'
  '44306105316' = 'EPYC 9V74'
  '44308110360' = 'Xeon 6975P-C'
}

$chart = New-Object System.Windows.Forms.DataVisualization.Charting.Chart
$chart.Width = 1500
$chart.Height = 520
$chart.BackColor = [Drawing.Color]::White
$chart.AntiAliasing = 'All'
$chart.TextAntiAliasingQuality = 'High'

function New-ChartFont([float]$Size, [string]$Style = 'Regular') {
  return [Drawing.Font]::new('Segoe UI', $Size, [Drawing.FontStyle]$Style)
}

$title = $chart.Titles.Add('Shuffle cost grows with width while reverse stays flat')
$title.Font = New-ChartFont 19 Bold
$title.ForeColor = [Drawing.ColorTranslator]::FromHtml('#172331')

$legend = $chart.Legends.Add('families')
$legend.Docking = 'Bottom'
$legend.Alignment = 'Center'
$legend.Font = New-ChartFont 11

for ($panel = 0; $panel -lt $jobs.Count; $panel++) {
  $job = $jobs[$panel]
  $area = $chart.ChartAreas.Add("runner-$panel")
  $area.Position = [System.Windows.Forms.DataVisualization.Charting.ElementPosition]::new((1 + 33 * $panel), 13, 32.5, 74)
  $area.InnerPlotPosition = [System.Windows.Forms.DataVisualization.Charting.ElementPosition]::new(17, 12, 78, 65)
  $area.BackColor = [Drawing.Color]::White
  $area.AxisX.Title = 'Dependency count'
  $area.AxisX.TitleFont = New-ChartFont 10
  $area.AxisX.Minimum = -0.25
  $area.AxisX.Maximum = 4.25
  $area.AxisX.MajorGrid.Enabled = $false
  $area.AxisX.MajorTickMark.Enabled = $false
  $area.AxisX.LabelStyle.Font = New-ChartFont 9
  $area.AxisX.LabelStyle.IsEndLabelVisible = $true
  $area.AxisX.IsLabelAutoFit = $false
  $area.AxisY.Minimum = 0.75
  $area.AxisY.Maximum = 2.30
  $area.AxisY.Interval = 0.25
  $area.AxisY.LabelStyle.Format = '0.00x'
  $area.AxisY.LabelStyle.Font = New-ChartFont 9
  $area.AxisY.Title = 'ns/source relative to N = 512'
  $area.AxisY.TitleFont = New-ChartFont 10
  $area.AxisY.MajorGrid.LineColor = [Drawing.ColorTranslator]::FromHtml('#D8E2EA')
  $area.AxisY.MajorTickMark.Enabled = $false
  $area.AxisX.LineColor = [Drawing.ColorTranslator]::FromHtml('#8B9AA8')
  $area.AxisY.LineColor = $area.AxisX.LineColor
  $caption = $chart.Titles.Add($cpuNames[$job.run])
  $caption.DockedToChartArea = $area.Name
  $caption.Docking = 'Top'
  $caption.IsDockedInsideChartArea = $false
  $caption.Font = New-ChartFont 12 Bold

  for ($i = 0; $i -lt $widths.Count; $i++) {
    $null = $area.AxisX.CustomLabels.Add(($i - 0.5), ($i + 0.5), [string]$widths[$i])
  }
  foreach ($family in @('shuffle', 'reverse')) {
    $series = $chart.Series.Add("$family-$panel")
    $series.ChartArea = $area.Name
    $series.Legend = $legend.Name
    $series.IsVisibleInLegend = ($panel -eq 0)
    $series.LegendText = $family
    $series.ChartType = 'Line'
    $series.BorderWidth = 4
    $series.MarkerSize = 9
    $series.MarkerStyle = if ($family -eq 'shuffle') { 'Circle' } else { 'Diamond' }
    $series.Color = if ($family -eq 'shuffle') {
      [Drawing.ColorTranslator]::FromHtml('#B95220')
    } else {
      [Drawing.ColorTranslator]::FromHtml('#176778')
    }
    $samples = @{}
    foreach ($row in $job.rows) {
      if ($row[1] -eq 'quant' -and $row[0].StartsWith("regime.$family@")) {
        $samples[$row[0]] = $row[2]
      }
    }
    $base = $samples["regime.$family@512"]
    for ($i = 0; $i -lt $widths.Count; $i++) {
      $n = $widths[$i]
      $cell = $samples["regime.$family@$n"]
      $ratios = @(for ($r = 0; $r -lt 7; $r++) { ($cell[$r] * 512.0) / ($base[$r] * $n) })
      $median = @($ratios | Sort-Object)[3]
      $null = $series.Points.AddXY([double]$i, [double]$median)
    }
  }
}

$chart.SaveImage([IO.Path]::GetFullPath($Output), 'Png')
$chart.Dispose()
