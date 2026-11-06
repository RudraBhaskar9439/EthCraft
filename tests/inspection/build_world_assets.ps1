# Build only. No host, world, wallet or provider changes.
$ErrorActionPreference = 'Stop'
$repoPath = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runtimePath = Join-Path $repoPath '.local/compatibility/server'
$depsPath = Join-Path $repoPath '.local/property-deps'
$active = Get-Content (Join-Path $repoPath '.local/playable-world/active.json') -Raw | ConvertFrom-Json
if ($active.owner -ne 'agentcity-playable-pilot' -or $active.javaImage -notmatch '^eclipse-temurin@sha256:[a-f0-9]{64}$') { throw 'PINNED_JAVA25_RUNTIME_REQUIRED' }
$dependencies = Get-Content (Join-Path $repoPath 'config/property-dependencies.json') -Raw | ConvertFrom-Json
foreach ($dependency in $dependencies.artifacts) {
    if ((Get-FileHash (Join-Path $depsPath $dependency.file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $dependency.sha256) { throw 'PROPERTY_DEPENDENCY_CHECKSUM_MISMATCH' }
}
$outputPath = Join-Path $repoPath ('.local/world-assets-build/' + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path (Join-Path $outputPath 'classes') -Force | Out-Null
$classpath = (@(Get-ChildItem (Join-Path $runtimePath 'libraries'),(Join-Path $runtimePath 'versions') -Filter '*.jar' -Recurse | Sort-Object FullName) | ForEach-Object { '/runtime/' + $_.FullName.Substring($runtimePath.Length + 1).Replace('\','/') }) -join ':'
foreach ($dependency in $dependencies.artifacts) { $classpath += ':/deps/' + $dependency.file }
$sourceFiles = @(Get-ChildItem (Join-Path $repoPath 'plugin/src/main/java') -Filter '*.java' -Recurse | Sort-Object FullName)
$hashes = [ordered]@{}
foreach ($source in @($sourceFiles) + @(Get-ChildItem (Join-Path $repoPath 'plugin/src/main/resources') -File -Recurse)) { $hashes[$source.FullName.Substring($repoPath.Length + 1).Replace('\','/')] = (Get-FileHash $source.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
$sources = @($sourceFiles | ForEach-Object { '/repo/' + $_.FullName.Substring($repoPath.Length + 1).Replace('\','/') })
$base = @('run','--rm','--network','none','--mount',"type=bind,src=$repoPath,dst=/repo,readonly",'--mount',"type=bind,src=$runtimePath,dst=/runtime,readonly",'--mount',"type=bind,src=$depsPath,dst=/deps,readonly",'--mount',"type=bind,src=$outputPath,dst=/output",$active.javaImage)
$ErrorActionPreference = 'Continue'
& docker @base javac --release 21 -proc:none -cp $classpath -d /output/classes @sources 2>&1 | Out-File (Join-Path $outputPath 'compile.log') -Encoding utf8
$compileExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($compileExit -ne 0) { Get-Content (Join-Path $outputPath 'compile.log'); throw 'WORLD_ASSETS_PLUGIN_COMPILE_FAILED' }
Copy-Item (Join-Path $repoPath 'plugin/src/main/resources/*') -Destination (Join-Path $outputPath 'classes') -Recurse -Force
& docker @base jar --create --file /output/AgentCity.jar --manifest /repo/plugin/src/main/resources/META-INF/MANIFEST.MF -C /output/classes .
if ($LASTEXITCODE -ne 0) { throw 'WORLD_ASSETS_PLUGIN_PACKAGE_FAILED' }
foreach ($file in $hashes.Keys) { if ((Get-FileHash (Join-Path $repoPath $file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hashes[$file]) { throw 'WORLD_ASSETS_BUILD_SOURCE_CHANGED' } }
$report = [ordered]@{status='pass';javaImage=$active.javaImage;release=21;dependencyPins=$dependencies.artifacts;sourceSha256=$hashes;artifact=(Join-Path $outputPath 'AgentCity.jar');sha256=(Get-FileHash (Join-Path $outputPath 'AgentCity.jar') -Algorithm SHA256).Hash.ToLowerInvariant();runtimeChanged=$false}
$report | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $outputPath 'build.json') -Encoding utf8
Write-Output (@{status=$report.status;artifact=$report.artifact;sha256=$report.sha256;buildReport=(Join-Path $outputPath 'build.json')} | ConvertTo-Json -Compress)
