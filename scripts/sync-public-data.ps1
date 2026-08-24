param(
    [switch]$Refresh
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$GitCommit = '1bb9549705eba2601affed4cb8a7ea69ba13b150'
$AkeVersion = '1.4.4@9433094-12'
$TableBase = 'https://data.akedata.wiki/public/1.4.4/9433094-12/TableCfg'
$JsonBase = 'https://data.akedata.wiki/public/Json'
$GitRawBase = "https://raw.githubusercontent.com/NagiYume/AKEDatabase/$GitCommit"
$PelicaPanelRequest = [ordered]@{
    uuid = 'pelica'
    id = 'chr_0004_pelica'
    level = 1
    potential = 0
    attrTalentLevel = 0
    passiveSkillLevels = @(0, 0)
    normalAttackLevel = 1
    normalSkillLevel = 1
    comboSkillLevel = 1
    ultimateSkillLevel = 1
    weapon = [ordered]@{
        id = 'wpn_funnel_0002'
        level = 1
        skillLevels = @(1, 1)
    }
    armorEquip = $null
    gloveEquip = $null
    kit1Equip = $null
    kit2Equip = $null
    tacticalItemId = $null
    tacticalItemCount = 0
}

function Get-SafeTargetPath {
    param([Parameter(Mandatory)][string]$RelativePath)

    $target = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $RelativePath))
    $prefix = $ProjectRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing path outside project: $RelativePath"
    }
    return $target
}

$Sources = @(
    @{ Id = 'akedata.manifest'; Url = 'https://data.akedata.wiki/manifest.json'; Path = 'reference/public-data/akedata/manifest.json' }
    @{ Id = 'akedata.asset-index'; Url = 'https://data.akedata.wiki/asset-sync-index.json'; Path = 'reference/public-data/akedata/asset-sync-index.json' }

    @{ Id = 'table.char-growth'; Url = "$TableBase/CharGrowthTable.json"; Path = 'reference/public-data/akedata/TableCfg/CharGrowthTable.json' }
    @{ Id = 'table.skill-patch'; Url = "$TableBase/SkillPatchTable.json"; Path = 'reference/public-data/akedata/TableCfg/SkillPatchTable.json' }
    @{ Id = 'table.potential-talent-effect'; Url = "$TableBase/PotentialTalentEffectTable.json"; Path = 'reference/public-data/akedata/TableCfg/PotentialTalentEffectTable.json' }
    @{ Id = 'table.use-item'; Url = "$TableBase/UseItemTable.json"; Path = 'reference/public-data/akedata/TableCfg/UseItemTable.json' }
    @{ Id = 'table.cc-tag'; Url = "$TableBase/CcTagTable.json"; Path = 'reference/public-data/akedata/TableCfg/CcTagTable.json' }
    @{ Id = 'table.enemy'; Url = "$TableBase/EnemyTable.json"; Path = 'reference/public-data/akedata/TableCfg/EnemyTable.json' }
    @{ Id = 'table.enemy-attribute-template'; Url = "$TableBase/EnemyAttributeTemplateTable.json"; Path = 'reference/public-data/akedata/TableCfg/EnemyAttributeTemplateTable.json' }
    @{ Id = 'table.enemy-template-display-info'; Url = "$TableBase/EnemyTemplateDisplayInfoTable.json"; Path = 'reference/public-data/akedata/TableCfg/EnemyTemplateDisplayInfoTable.json' }
    @{ Id = 'table.display-enemy-type'; Url = "$TableBase/DisplayEnemyTypeTable.json"; Path = 'reference/public-data/akedata/TableCfg/DisplayEnemyTypeTable.json' }

    @{ Id = 'skill.pelica-attack1'; Url = "$JsonBase/SkillData/chr_0004_pelica_attack1.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack1.json' }
    @{ Id = 'skill.pelica-attack1-projhit'; Url = "$JsonBase/SkillData/chr_0004_pelica_attack1_projhit.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack1_projhit.json' }
    @{ Id = 'skill.pelica-attack1-projhit02'; Url = "$JsonBase/SkillData/chr_0004_pelica_attack1_projhit02.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack1_projhit02.json' }
    @{ Id = 'skill.pelica-attack2'; Url = "$JsonBase/SkillData/chr_0004_pelica_attack2.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack2.json' }
    @{ Id = 'skill.pelica-attack2-projhit'; Url = "$JsonBase/SkillData/chr_0004_pelica_attack2_projhit.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack2_projhit.json' }
    @{ Id = 'skill.pelica-attack3'; Url = "$JsonBase/SkillData/chr_0004_pelica_attack3.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack3.json' }
    @{ Id = 'skill.pelica-attack3-projhit'; Url = "$JsonBase/SkillData/chr_0004_pelica_attack3_projhit.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack3_projhit.json' }
    @{ Id = 'skill.pelica-attack4'; Url = "$JsonBase/SkillData/chr_0004_pelica_attack4.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack4.json' }
    @{ Id = 'skill.pelica-attack4-projhit'; Url = "$JsonBase/SkillData/chr_0004_pelica_attack4_projhit.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack4_projhit.json' }
    @{ Id = 'skill.pelica-attack4-projhit-no-effect'; Url = "$JsonBase/SkillData/chr_0004_pelica_attack4_projhit_no_effect.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_attack4_projhit_no_effect.json' }
    @{ Id = 'skill.pelica-combo'; Url = "$JsonBase/SkillData/chr_0004_pelica_combo_skill.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_combo_skill.json' }
    @{ Id = 'skill.pelica-combo-projhit'; Url = "$JsonBase/SkillData/chr_0004_pelica_combo_skill_projhit.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_combo_skill_projhit.json' }
    @{ Id = 'skill.pelica-normal'; Url = "$JsonBase/SkillData/chr_0004_pelica_normal_skill.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_normal_skill.json' }
    @{ Id = 'skill.pelica-ultimate'; Url = "$JsonBase/SkillData/chr_0004_pelica_ultimate_skill.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_ultimate_skill.json' }
    @{ Id = 'skill.pelica-power-attack'; Url = "$JsonBase/SkillData/chr_0004_pelica_power_attack.json"; Path = 'reference/public-data/akedata/Json/SkillData/chr_0004_pelica_power_attack.json' }
    @{ Id = 'buff.pulse-attached'; Url = "$JsonBase/BuffData/buff_common_energy_shard_attached_pulse.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_energy_shard_attached_pulse.json' }
    @{ Id = 'buff.pulse-pulse-triggered'; Url = "$JsonBase/BuffData/buff_common_pulse_pulse_triggered.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_pulse_pulse_triggered.json' }
    @{ Id = 'buff.pulse-conduct-triggered'; Url = "$JsonBase/BuffData/buff_common_pulse_pulse_conduct_triggered.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_pulse_pulse_conduct_triggered.json' }
    @{ Id = 'buff.pulse-conduct-triggered-do'; Url = "$JsonBase/BuffData/buff_common_pulse_pulse_conduct_triggered_do.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_pulse_pulse_conduct_triggered_do.json' }
    @{ Id = 'buff.pulse-triggered-start'; Url = "$JsonBase/BuffData/buff_common_pulse_triggered_start.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_pulse_triggered_start.json' }
    @{ Id = 'buff.pulse-triggered-fx'; Url = "$JsonBase/BuffData/buff_common_pulse_triggered_fx.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_pulse_triggered_fx.json' }
    @{ Id = 'buff.pelica-combo-tutorial-marker'; Url = "$JsonBase/BuffData/buff_chr_0004_pelica_combo_skill_tutorial_marker.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_chr_0004_pelica_combo_skill_tutorial_marker.json' }
    @{ Id = 'buff.obtain-ultimate-sp'; Url = "$JsonBase/BuffData/buff_common_obtain_ultimate_sp.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_obtain_ultimate_sp.json' }
    @{ Id = 'buff.damage-immune-ultimate'; Url = "$JsonBase/BuffData/buff_common_damage_immune_ult_skill.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_damage_immune_ult_skill.json' }
    @{ Id = 'buff.damage-immune-medium'; Url = "$JsonBase/BuffData/buff_common_damage_immune_medium.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_damage_immune_medium.json' }
    @{ Id = 'buff.power-attack-disable-cast'; Url = "$JsonBase/BuffData/buff_common_power_attack_disable_cast_skill.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_power_attack_disable_cast_skill.json' }
    @{ Id = 'buff.poise-mini-break'; Url = "$JsonBase/BuffData/buff_common_mini_poise_break.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_mini_poise_break.json' }
    @{ Id = 'buff.poise-breaking-window'; Url = "$JsonBase/BuffData/buff_common_poise_can_be_breaking_attacked.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_poise_can_be_breaking_attacked.json' }
    @{ Id = 'buff.poise-break-damage-scale'; Url = "$JsonBase/BuffData/buff_common_poise_break_damage_taken_scale.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_poise_break_damage_taken_scale.json' }
    @{ Id = 'buff.poise-recovery-time'; Url = "$JsonBase/BuffData/buff_common_poise_rectime.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_poise_rectime.json' }
    @{ Id = 'buff.poise-recover'; Url = "$JsonBase/BuffData/buff_common_recoverpoise.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_recoverpoise.json' }
    @{ Id = 'buff.poise-guard'; Url = "$JsonBase/BuffData/buff_common_poise_guard.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_poise_guard.json' }
    @{ Id = 'buff.resilience-decrease'; Url = "$JsonBase/BuffData/buff_common_resilience_decrease.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_resilience_decrease.json' }
    @{ Id = 'buff.poise-set-max'; Url = "$JsonBase/BuffData/buff_common_setmaxpoise.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_setmaxpoise.json' }
    @{ Id = 'buff.poise-temporary-break'; Url = "$JsonBase/BuffData/buff_common_temp_poise_break.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_temp_poise_break.json' }
    @{ Id = 'buff.poise-temporary-damage-ratio'; Url = "$JsonBase/BuffData/buff_common_temp_poise_damage_ratio.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_temp_poise_damage_ratio.json' }
    @{ Id = 'buff.cc-main-attribute-down'; Url = "$JsonBase/BuffData/buff_cc_chr_main_attribute_down.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_cc_chr_main_attribute_down.json' }
    @{ Id = 'buff.heal-moss'; Url = "$JsonBase/BuffData/buff_common_heal_moss_1.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_common_heal_moss_1.json' }
    @{ Id = 'buff.pelica-potential-3'; Url = "$JsonBase/BuffData/buff_chr_0004_pelica_potential_3.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_chr_0004_pelica_potential_3.json' }
    @{ Id = 'buff.pelica-potential-3-atkup'; Url = "$JsonBase/BuffData/buff_chr_0004_pelica_potential_3_atkup.json"; Path = 'reference/public-data/akedata/Json/BuffData/buff_chr_0004_pelica_potential_3_atkup.json' }

    @{ Id = 'ake.readme'; Url = "$GitRawBase/README.md"; Path = 'reference/third-party/akedatabase/README.upstream.md' }
    @{ Id = 'ake.license'; Url = "$GitRawBase/LICENSE"; Path = 'reference/third-party/akedatabase/LICENSE' }
    @{ Id = 'ake.buff-parser'; Url = "$GitRawBase/plugin/js/v3-buff-data.js"; Path = 'reference/third-party/akedatabase/plugin/js/v3-buff-data.js' }
    @{ Id = 'ake.buff-page'; Url = "$GitRawBase/plugin/js/v3-buff.js"; Path = 'reference/third-party/akedatabase/plugin/js/v3-buff.js' }
    @{ Id = 'ake.skill-parser'; Url = "$GitRawBase/plugin/js/v3-skill-data.js"; Path = 'reference/third-party/akedatabase/plugin/js/v3-skill-data.js' }
    @{ Id = 'ake.skill-page'; Url = "$GitRawBase/plugin/js/v3-skill.js"; Path = 'reference/third-party/akedatabase/plugin/js/v3-skill.js' }
    @{ Id = 'ake.level-buff-parser'; Url = "$GitRawBase/plugin/js/ake-combat-data.js"; Path = 'reference/third-party/akedatabase/plugin/js/ake-combat-data.js' }
    @{ Id = 'ake.item-parser'; Url = "$GitRawBase/plugin/js/v2-item.js"; Path = 'reference/third-party/akedatabase/plugin/js/v2-item.js' }
    @{ Id = 'ake.stats'; Url = "$GitRawBase/plugin/js/ake-stats.js"; Path = 'reference/third-party/akedatabase/plugin/js/ake-stats.js' }
    @{ Id = 'ake.enemy-renderer'; Url = "$GitRawBase/plugin/js/ake-enemy-renderer.js"; Path = 'reference/third-party/akedatabase/plugin/js/ake-enemy-renderer.js' }
    @{ Id = 'ake.enemy-page'; Url = "$GitRawBase/plugin/js/v2-enemy.js"; Path = 'reference/third-party/akedatabase/plugin/js/v2-enemy.js' }
    @{ Id = 'ake.table-adapter'; Url = "$GitRawBase/plugin/js/v3-table-data.js"; Path = 'reference/third-party/akedatabase/plugin/js/v3-table-data.js' }
    @{ Id = 'ake.cc-research'; Url = "$GitRawBase/public/CH/research/%E5%8D%B1%E6%9C%BA%E5%90%88%E7%BA%A6Buff%E6%9C%BA%E5%88%B6%E5%88%86%E6%9E%90v2.md"; Path = 'reference/third-party/akedatabase/research/cc-buff-analysis-v2.md' }
    @{ Id = 'ake.mechanics-guide'; Url = "$GitRawBase/public/CH/research/%E7%BB%88%E6%9C%AB%E5%9C%B0%E6%95%B0%E6%8D%AE%E6%9C%BA%E5%88%B6%E5%AF%BC%E8%AE%BA.md"; Path = 'reference/third-party/akedatabase/research/endfield-data-mechanics-guide.md' }

    @{ Id = 'calc.home'; Url = 'https://calc.perlica.tech/'; Path = 'reference/public-data/calc/home.html' }
    @{ Id = 'calc.simulation-bundle'; Url = 'https://calc.perlica.tech/_nuxt/Cgx2mFCV.js'; Path = 'reference/public-data/calc/_nuxt/Cgx2mFCV.js' }
    @{ Id = 'calc.metadata'; Url = 'https://calc.perlica.tech/api/openapi/metadata'; Path = 'reference/public-data/calc/api/metadata.json' }
    @{ Id = 'calc.character-pelica'; Url = 'https://calc.perlica.tech/api/openapi/characters/chr_0004_pelica'; Path = 'reference/public-data/calc/api/character-chr_0004_pelica.json' }
    @{ Id = 'calc.character-panel-pelica-level1'; Url = 'https://calc.perlica.tech/api/openapi/characters/panel'; Path = 'reference/public-data/calc/api/character-panel-chr_0004_pelica-level1.json'; Method = 'POST'; Body = $PelicaPanelRequest }
    @{ Id = 'calc.weapon-pelica-default'; Url = 'https://calc.perlica.tech/api/openapi/weapons/wpn_funnel_0002'; Path = 'reference/public-data/calc/api/weapon-wpn_funnel_0002.json' }
    @{ Id = 'calc.enemy-mimicw-level1'; Url = 'https://calc.perlica.tech/api/openapi/enemies/template/eny_0007_mimicw?level=1'; Path = 'reference/public-data/calc/api/enemy-eny_0007_mimicw-level1.json' }
    @{ Id = 'calc.enemy-lbtough-level1'; Url = 'https://calc.perlica.tech/api/openapi/enemies/template/eny_0018_lbtough?level=1'; Path = 'reference/public-data/calc/api/enemy-eny_0018_lbtough-level1.json' }
    @{ Id = 'calc.enemy-lbtough-variant-level1'; Url = 'https://calc.perlica.tech/api/openapi/enemies/template/eny_0018_lbtough_001?level=1'; Path = 'reference/public-data/calc/api/enemy-eny_0018_lbtough_001-level1.json' }
    @{ Id = 'calc.enemy-agmelee-level1'; Url = 'https://calc.perlica.tech/api/openapi/enemies/template/eny_0021_agmelee?level=1'; Path = 'reference/public-data/calc/api/enemy-eny_0021_agmelee-level1.json' }
    @{ Id = 'calc.enemy-klbud-level1'; Url = 'https://calc.perlica.tech/api/openapi/enemies/template/eny_0121_klbud?level=1'; Path = 'reference/public-data/calc/api/enemy-eny_0121_klbud-level1.json' }
    @{ Id = 'calc.contingency-contracts'; Url = 'https://calc.perlica.tech/api/openapi/contingency-contracts?page=1&pageSize=200'; Path = 'reference/public-data/calc/api/contingency-contracts.json' }
    @{ Id = 'calc.use-items'; Url = 'https://calc.perlica.tech/api/openapi/use-items?page=1&pageSize=200'; Path = 'reference/public-data/calc/api/use-items.json' }
)

$records = foreach ($source in $Sources) {
    $target = Get-SafeTargetPath -RelativePath $source.Path
    $targetDirectory = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    $method = if ($source.ContainsKey('Method')) { [string]$source.Method } else { 'GET' }
    $requestBody = if ($source.ContainsKey('Body')) { $source.Body } else { $null }

    $etag = $null
    $lastModified = $null
    $downloadedAt = $null

    if ($Refresh -or -not (Test-Path -LiteralPath $target -PathType Leaf)) {
        $temporary = "$target.download"
        if (Test-Path -LiteralPath $temporary -PathType Leaf) {
            Remove-Item -LiteralPath $temporary -Force
        }

        try {
            Write-Host "Downloading $($source.Id)"
            $request = @{
                Uri = $source.Url
                Method = $method
                UseBasicParsing = $true
                OutFile = $temporary
            }
            if ($null -ne $requestBody) {
                $request.Body = $requestBody | ConvertTo-Json -Depth 30 -Compress
                $request.ContentType = 'application/json'
            }
            $response = Invoke-WebRequest @request
            if ($null -ne $response) {
                $etag = [string]$response.Headers['ETag']
                $lastModified = [string]$response.Headers['Last-Modified']
            }
            Move-Item -LiteralPath $temporary -Destination $target -Force
            $downloadedAt = (Get-Date).ToUniversalTime().ToString('o')
        }
        finally {
            if (Test-Path -LiteralPath $temporary -PathType Leaf) {
                Remove-Item -LiteralPath $temporary -Force
            }
        }
    }
    else {
        Write-Host "Keeping existing $($source.Id)"
    }

    $file = Get-Item -LiteralPath $target
    $hash = Get-FileHash -LiteralPath $target -Algorithm SHA256
    [ordered]@{
        id = $source.Id
        url = $source.Url
        method = $method
        requestBody = $requestBody
        path = $source.Path.Replace('\\', '/')
        bytes = $file.Length
        sha256 = $hash.Hash.ToLowerInvariant()
        downloadedAt = $downloadedAt
        etag = $etag
        lastModified = $lastModified
    }
}

$lock = [ordered]@{
    schemaVersion = 1
    generatedAt = (Get-Date).ToUniversalTime().ToString('o')
    pins = [ordered]@{
        akedataTableVersion = $AkeVersion
        akedataJsonRevision = ((Get-Content -LiteralPath (Get-SafeTargetPath -RelativePath 'reference/public-data/akedata/asset-sync-index.json') -Raw | ConvertFrom-Json -Depth 30).revision)
        akeDatabaseCommit = $GitCommit
        calcDataVersion = ((Get-Content -LiteralPath (Get-SafeTargetPath -RelativePath 'reference/public-data/calc/api/metadata.json') -Raw | ConvertFrom-Json -Depth 10).data.version)
        calcBundle = '/_nuxt/Cgx2mFCV.js'
    }
    sources = $records
}

$lockPath = Get-SafeTargetPath -RelativePath 'sources.lock.json'
$lock | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $lockPath -Encoding utf8NoBOM
Write-Host "Wrote $lockPath"
