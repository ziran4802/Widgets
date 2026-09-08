const { spawn, spawnSync } = require('node:child_process');

const POWERSHELL_RESOURCE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$gpuPercent = $null
$gpuLuid = ''
$gpuAdapterKind = 'unknown'
$gpuReason = 'metric=gpu; reason=GPU Engine counter unavailable'
try {
  function Get-GpuLuid([string]$instanceName) {
    if ($instanceName -match 'luid[_-]0x?(?<high>[0-9a-f]+)[_-]0x?(?<low>[0-9a-f]+)') {
      return (('{0}{1}' -f $Matches.high.PadLeft(8, '0'), $Matches.low.PadLeft(8, '0')).ToUpperInvariant())
    }
    return $null
  }
  $engineSamples = @(Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction Stop | Select-Object -ExpandProperty CounterSamples)
  $dedicatedSamples = @()
  try { $dedicatedSamples = @(Get-Counter -Counter '\GPU Adapter Memory(*)\Dedicated Usage' -ErrorAction Stop | Select-Object -ExpandProperty CounterSamples) } catch {}
  $gpuByLuid = @{}
  foreach ($sample in $engineSamples) {
    $luid = Get-GpuLuid ([string]$sample.InstanceName)
    $value = [double]$sample.CookedValue
    if (-not $luid -or $value -lt 0 -or $value -gt 100) { continue }
    if (-not $gpuByLuid.ContainsKey($luid)) { $gpuByLuid[$luid] = [ordered]@{ luid = $luid; max = 0.0; dedicated = 0.0 } }
    if ($value -gt $gpuByLuid[$luid].max) { $gpuByLuid[$luid].max = $value }
  }
  foreach ($sample in $dedicatedSamples) {
    $luid = Get-GpuLuid ([string]$sample.InstanceName)
    $value = [double]$sample.CookedValue
    if (-not $luid -or $value -lt 0) { continue }
    if (-not $gpuByLuid.ContainsKey($luid)) { $gpuByLuid[$luid] = [ordered]@{ luid = $luid; max = 0.0; dedicated = 0.0 } }
    if ($value -gt $gpuByLuid[$luid].dedicated) { $gpuByLuid[$luid].dedicated = $value }
  }
  $selectedGpu = @($gpuByLuid.Values | Sort-Object @{ Expression = { if ($_.dedicated -gt 0) { 1 } else { 0 } }; Descending = $true }, @{ Expression = { $_.dedicated }; Descending = $true }, @{ Expression = { $_.max }; Descending = $true } | Select-Object -First 1)
  if ($selectedGpu.Count -gt 0) {
    $gpuPercent = [double]$selectedGpu[0].max
    $gpuLuid = [string]$selectedGpu[0].luid
    if ([double]$selectedGpu[0].dedicated -gt 0) { $gpuAdapterKind = 'discrete' }
    $gpuReason = ''
  }
} catch {
  $gpuReason = 'metric=gpu; reason=GPU Engine counter read failed'
}
$network = $null
$networkReason = 'metric=network; reason=network interface counter unavailable'
try {
  $samples = @(Get-Counter -Counter '\Network Interface(*)\Bytes Received/sec','\Network Interface(*)\Bytes Sent/sec' -ErrorAction Stop | Select-Object -ExpandProperty CounterSamples)
  $rows = @{}
  foreach ($sample in $samples) {
    if ($sample.Path -match '\\network interface\((?<name>[^)]*)\)\\bytes (?<direction>received|sent)/sec$') {
      $name = [string]$Matches.name
      if (-not $rows.ContainsKey($name)) { $rows[$name] = [ordered]@{ received = 0.0; sent = 0.0 } }
      if ($Matches.direction -eq 'received') { $rows[$name].received = [double]$sample.CookedValue } else { $rows[$name].sent = [double]$sample.CookedValue }
    }
  }
  $selected = $rows.GetEnumerator() | Where-Object { $_.Key -notmatch 'loopback|teredo|wan miniport|virtual|vmware|kernel debug|isatap' } | Sort-Object { $_.Value.received + $_.Value.sent } -Descending | Select-Object -First 1
  if ($null -ne $selected) {
    $network = [ordered]@{ interfaceId = [string]$selected.Key; downloadBytesPerSecond = [double]$selected.Value.received; uploadBytesPerSecond = [double]$selected.Value.sent; mode = 'rate' }
    $networkReason = ''
  }
} catch {
  $networkReason = 'metric=network; reason=network interface counter read failed'
}
[ordered]@{ gpuPercent = $gpuPercent; gpuLuid = $gpuLuid; gpuAdapterKind = $gpuAdapterKind; gpuReason = $gpuReason; network = $network; networkReason = $networkReason } | ConvertTo-Json -Compress -Depth 4
`;

function unavailableResources(reason = 'metric resources unavailable') {
  return {
    gpu: { phase: 'unavailable', usagePercent: null, reason },
    network: { phase: 'unavailable', interfaceId: null, receivedBytes: null, sentBytes: null, reason }
  };
}

function resourceArguments() {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', POWERSHELL_RESOURCE_SCRIPT];
}

function finitePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function counterValue(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeGpuLuid(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/luid[_-]0x?([0-9a-f]+)[_-]0x?([0-9a-f]+)/i);
  if (!match) return null;
  return `${match[1].padStart(8, '0')}${match[2].padStart(8, '0')}`.toUpperCase();
}

function selectGpuSample(engineSamples = [], dedicatedSamples = []) {
  const byLuid = new Map();
  const ensure = luid => {
    if (!byLuid.has(luid)) byLuid.set(luid, { luid, max: 0, dedicated: 0 });
    return byLuid.get(luid);
  };
  for (const sample of Array.isArray(engineSamples) ? engineSamples : []) {
    const luid = normalizeGpuLuid(sample?.instanceName);
    const value = Number(sample?.value);
    if (!luid || !Number.isFinite(value) || value < 0 || value > 100) continue;
    const candidate = ensure(luid);
    candidate.max = Math.max(candidate.max, value);
  }
  for (const sample of Array.isArray(dedicatedSamples) ? dedicatedSamples : []) {
    const luid = normalizeGpuLuid(sample?.instanceName);
    const value = Number(sample?.value);
    if (!luid || !Number.isFinite(value) || value < 0) continue;
    const candidate = ensure(luid);
    candidate.dedicated = Math.max(candidate.dedicated, value);
  }
  const selected = [...byLuid.values()].sort((left, right) => (Number(right.dedicated > 0) - Number(left.dedicated > 0)) || (right.dedicated - left.dedicated) || (right.max - left.max))[0];
  if (!selected) return { usagePercent: null, luid: null, adapterKind: 'unknown', reason: 'metric=gpu; reason=GPU adapter unavailable' };
  return {
    usagePercent: selected.max,
    luid: selected.luid,
    adapterKind: selected.dedicated > 0 ? 'discrete' : 'unknown',
    reason: ''
  };
}

function parseResourceOutput(output) {
  if (typeof output !== 'string' || output.trim().length === 0) throw new Error('resource provider returned no output');
  const value = JSON.parse(output);
  const adapterKind = value.gpuAdapterKind === 'discrete' || value.gpuAdapterKind === 'integrated' ? value.gpuAdapterKind : undefined;
  const gpu = finitePercent(value.gpuPercent)
    ? { phase: 'available', usagePercent: Math.round(value.gpuPercent * 10) / 10, reason: '', ...(adapterKind ? { adapterKind } : {}) }
    : { phase: 'unavailable', usagePercent: null, reason: typeof value.gpuReason === 'string' && value.gpuReason ? value.gpuReason : 'metric=gpu; reason=GPU value unavailable' };
  const hasRate = value.network && Number.isFinite(Number(value.network.downloadBytesPerSecond)) && Number.isFinite(Number(value.network.uploadBytesPerSecond));
  const network = value.network && typeof value.network.interfaceId === 'string' && value.network.interfaceId.length > 0 && hasRate
    ? { phase: 'available', interfaceId: value.network.interfaceId, mode: 'rate', downloadBytesPerSecond: Math.max(0, Number(value.network.downloadBytesPerSecond)), uploadBytesPerSecond: Math.max(0, Number(value.network.uploadBytesPerSecond)), reason: '' }
    : value.network && typeof value.network.interfaceId === 'string' && value.network.interfaceId.length > 0
      ? { phase: 'available', interfaceId: value.network.interfaceId, mode: 'counter', receivedBytes: counterValue(value.network.receivedBytes), sentBytes: counterValue(value.network.sentBytes), reason: '' }
    : { phase: 'unavailable', interfaceId: null, receivedBytes: null, sentBytes: null, reason: typeof value.networkReason === 'string' && value.networkReason ? value.networkReason : 'metric=network; reason=network value unavailable' };
  if (network.phase === 'available' && network.mode === 'counter' && (network.receivedBytes === null || network.sentBytes === null)) {
    network.phase = 'unavailable';
    network.reason = 'metric=network; reason=counter value invalid';
  }
  return { gpu, network };
}

function readSystemResources({ platform = process.platform, command = 'powershell.exe', spawn = spawnSync } = {}) {
  if (platform !== 'win32') return unavailableResources('metric resources unavailable on this platform');
  let result;
  try {
    result = spawn(command, resourceArguments(), {
      encoding: 'utf8',
      timeout: 6500,
      windowsHide: true,
      maxBuffer: 128 * 1024
    });
  } catch {
    return unavailableResources('metric resources provider failed to start');
  }
  if (!result || result.status !== 0 || result.error) return unavailableResources('metric resources provider failed');
  try { return parseResourceOutput(result.stdout); } catch { return unavailableResources('metric resources provider returned invalid data'); }
}

function readSystemResourcesAsync({ platform = process.platform, command = 'powershell.exe', spawnProcess = spawn, signal, timeoutMs = 6500 } = {}) {
  if (platform !== 'win32') return Promise.resolve(unavailableResources('metric resources unavailable on this platform'));
  return new Promise(resolve => {
    let child;
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child?.kill(); } catch {}
      finish(unavailableResources('metric resources provider timed out'));
    }, timeoutMs);
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawnProcess(command, resourceArguments(), { windowsHide: true, signal });
      child.stdout?.on('data', chunk => { stdout += chunk.toString(); });
      child.on('error', () => finish(unavailableResources('metric resources provider failed to start')));
      child.on('close', code => {
        if (code !== 0) return finish(unavailableResources('metric resources provider failed'));
        try { finish(parseResourceOutput(stdout)); } catch { finish(unavailableResources('metric resources provider returned invalid data')); }
      });
    } catch {
      finish(unavailableResources('metric resources provider failed to start'));
    }
  });
}

module.exports = { POWERSHELL_RESOURCE_SCRIPT, counterValue, normalizeGpuLuid, parseResourceOutput, readSystemResources, readSystemResourcesAsync, selectGpuSample, unavailableResources };
