<template>
  <component :is="desktopMode ? 'div' : AppLayout" :class="{ 'cost-desktop-workspace': desktopMode }">
    <div v-if="desktopMode" class="cost-desktop-navigation console-theme"><ConsoleWorkspaceHeader /></div>
    <div
      class="cost-console console-theme"
      :aria-busy="loading || refreshing"
      data-aui-fidelity="apple-fidelity-web/v1"
      data-aui-profile="macos-productivity"
      data-aui-appearance="dark"
      data-aui-component="window"
      data-aui-adaptive="workspace"
      :class="{
        'cost-console--embedded': !desktopMode,
      }"
    >
      <header
        id="cost-toolbar-edge"
        class="cost-toolbar"
        data-aui-layer="functional"
        data-aui-component="toolbar"
        data-aui-material="regular"
        data-aui-material-scope="primary-functional"
        data-aui-backdrop="mixed"
        data-aui-scroll-edge="hard"
      >
        <div class="cost-brand-block">
          <span class="cost-eyebrow">{{ brandEyebrow }}</span>
          <h1 :title="panelTitle">{{ panelTitle }}</h1>
          <p>{{ panelDescription }} {{ t('costCenter.text.algorithmV') }}{{ COST_ALGORITHM_VERSION }}</p>
        </div>

        <button v-if="desktopMode" type="button" class="cost-tool-button cost-back-button" :title="t('costCenter.text.backToConnections')" :aria-label="t('costCenter.text.backToConnections')" @click="goBackToConnect">
          <ArrowLeft :size="16" /><span>{{ t('costCenter.text.backToConnections2') }}</span>
        </button>

        <nav
          class="cost-workspaces"
          :aria-label="t('costCenter.text.costCenterWorkspaces')"
          data-aui-component="segmented"
          data-aui-adaptive-region="navigation"
        >
          <button
            v-for="item in visibleWorkspaceItems"
            :key="item.key"
            type="button"
            data-aui-component="button"
            data-aui-pressable
            :class="{ active: activePanel === item.key }"
            :aria-current="activePanel === item.key ? 'page' : undefined"
            :aria-pressed="activePanel === item.key"
            @click="activePanel = item.key"
          >
            <component :is="item.icon" :size="15" />
            <span>{{ item.label }}</span>
            <kbd>{{ item.shortcut }}</kbd>
          </button>
          <button
            v-if="connectionType === 'sub2api'"
            type="button"
            class="cost-workspaces__settings"
            data-aui-component="button"
            :title="t('costCenter.text.openSub2apiSystemSettings')"
            @click="openSub2APISettings"
          >
            <Settings2 :size="15" />
            <span>{{ t('costCenter.text.sub2apiSettings') }}</span>
            <ExternalLink :size="11" />
          </button>
        </nav>

        <div class="cost-toolbar__actions">
          <label class="cost-select-label">
            <span>{{ t('costCenter.text.timeRange') }}</span>
            <select v-model="range" :aria-label="t('costCenter.text.timeRange')">
              <option value="today">{{ t('costCenter.text.today2') }}</option>
              <option value="1m">{{ t('costCenter.text.last1Minute') }}</option>
              <option value="5m">{{ t('costCenter.text.last5Minutes') }}</option>
              <option value="30m">{{ t('costCenter.text.last30Minutes') }}</option>
              <option value="1h">{{ t('costCenter.text.last1Hour') }}</option>
              <option value="6h">{{ t('costCenter.text.last6Hours') }}</option>
              <option value="24h">{{ t('costCenter.text.last24Hours') }}</option>
              <option value="7d">{{ t('costCenter.text.last7Days') }}</option>
              <option value="30d">{{ t('costCenter.text.last30Days') }}</option>
            </select>
          </label>
          <label class="cost-select-label cost-refresh-interval-label">
            <span>{{ t('costCenter.text.refreshInterval') }}</span>
            <select v-model.number="refreshIntervalSeconds" :aria-label="t('costCenter.text.autoRefreshInterval')">
              <option :value="5">{{ t('costCenter.text.5Seconds') }}</option>
              <option :value="10">{{ t('costCenter.text.10Seconds') }}</option>
              <option :value="15">{{ t('costCenter.text.15Seconds') }}</option>
              <option :value="30">{{ t('costCenter.text.30Seconds') }}</option>
            </select>
          </label>
          <button type="button" class="cost-tool-button cost-auto-refresh" :class="{ active: autoRefresh }" :title="autoRefresh ? t('costCenter.text.autoRefresh2', { value0: autoRefreshLabel }) : t('costCenter.text.enableAutoRefresh')" :aria-label="autoRefresh ? t('costCenter.text.pauseAutoRefresh') : t('costCenter.text.enableAutoRefresh')" :aria-pressed="autoRefresh" @click="toggleAutoRefresh">
            <Activity :size="16" />
            <span>{{ autoRefreshLabel }}</span>
          </button>
          <button v-if="isTauriDesktop" type="button" class="cost-icon-button" :class="{ active: activePanel === 'finance' }" :aria-label="t('costCenter.text.costLedger')" :title="t('costCenter.text.purchasesRenewalsRefundsAndTerminationLosses')" @click="activePanel = 'finance'">
            <ReceiptText :size="16" />
          </button>
          <button type="button" class="cost-icon-button cost-governance-button" :class="{ active: activePanel === 'governance' }" :aria-current="activePanel === 'governance' ? 'page' : undefined" :aria-label="t('costCenter.text.dataManagement')" :title="t('costCenter.text.dataSourcesHistoricalDataAndRetentionPolicy')" @click="activePanel = 'governance'">
            <CircleCheck :size="16" />
          </button>
          <button type="button" class="cost-icon-button" :title="t('costCenter.text.refreshCtrlR')" :aria-label="t('costCenter.text.refreshData')" :disabled="loading" @click="reload()">
            <RefreshCcw :size="17" :class="{ 'cost-spin': loading }" />
          </button>
          <button type="button" class="cost-icon-button" :title="t('costCenter.text.fullscreenF11')" :aria-label="t('costCenter.text.toggleFullscreen')" @click="toggleFullscreen">
            <Maximize2 :size="17" />
          </button>
        </div>
      </header>

      <div v-if="displayError" class="cost-error" role="alert">
        <TriangleAlert :size="17" />
        <span>{{ displayError }}</span>
          <button type="button" @click="reload()">{{ t('costCenter.text.retry') }}</button>
      </div>
      <div v-if="connectionType !== 'sub2api' && data.legacyLocalCostProfileCount.value" class="cost-warning-text" role="status">
        {{ data.legacyLocalCostProfileCount.value }} {{ t('costCenter.text.legacyCostProfilesLackReliableSourceIdentitiesRetained') }}
      </div>
      <div v-if="data.localCostProfilesError.value" class="cost-warning-text" role="status">
        {{ t('costCenter.integration.costSettingsUnconfirmed') }} {{ data.localCostProfilesError.value }}
      </div>

      <main
        data-aui-layer="content"
        data-aui-component="content-plane"
        data-aui-adaptive-region="content"
        data-aui-scroll-edge-source="true"
        data-aui-scroll-edge-target="#cost-toolbar-edge"
      >
        <section v-if="activePanel === 'overview'" class="cost-workspace cost-overview" aria-labelledby="overview-title">
          <div class="cost-quality-strip">
            <div class="cost-quality-strip__intro">
              <span>{{ t('costCenter.text.overallQuality') }}</span>
              <h2 id="overview-title">{{ t('costCenter.text.accountOverview') }}</h2>
              <p>{{ lastUpdatedLabel }} {{ t('costCenter.text.last') }} {{ hasMeasuredData(activitySourceState) ? formatInteger(totalObservedRequests) : t('costCenter.text.noData') }} {{ t('costCenter.text.calls') }} {{ currentAccountsReady ? activeAccounts.length : t('costCenter.text.noData') }} {{ t('costCenter.text.schedulableAccounts') }}<span v-if="sourceStates.accounts.status === 'stale'" class="cost-muted">{{ t('costCenter.text.lastSuccessfulSnapshot') }}</span><span v-if="cockpitRequestCountNote" class="cost-muted"> · {{ cockpitRequestCountNote }}</span></p>
            </div>
            <!-- 审查 #7:标注必须跟数值的真实来源一致;health_score 缺失时是账号状态推算,不写「Ops 实测」。 -->
            <MetricCell :label="t('costCenter.text.accountScore')" :value="qualityScore == null ? unavailableValueLabel(sourceStates.accounts) : qualityScore.toFixed(1)" :note="qualityScore == null ? t('costCenter.text.noUsableInputs', { value0: qualityProvenanceLabel }) : `${qualityGrade} · ${qualityProvenanceLabel}`" :state="qualityProvenance === 'ops' ? sourceStates.ops.status : sourceStates.accounts.status === 'measured' ? 'estimated' : sourceStates.accounts.status" accent="lime" />
            <!-- 审查 #6:零观测时失败率显示 —,绝不显示 0.0%(那等于断言"零失败")。 -->
            <MetricCell :label="t('costCenter.text.successFailure')" :value="opsOverview ? `${formatInteger(successCount)} / ${formatInteger(errorCount)}` : unavailableValueLabel(sourceStates.ops)" :note="requestFailureNote" :state="sourceStates.ops.status" />
            <MetricCell :label="t('costCenter.text.switchesRecoveries')" :value="!opsOverview ? unavailableValueLabel(sourceStates.ops) : switchCount == null ? t('costCenter.text.noData') : t('costCenter.text.noData2', { value0: formatInteger(switchCount) })" :note="switchCount == null ? (connectionType === 'sub2api' ? t('costCenter.text.noSwitchSamplesInTheSelectedPeriodRecovery') : t('costCenter.text.thisSourceDoesNotCollectSwitchOrRecovery')) : t('costCenter.text.actualSwitchesCollectedRecoveryEventsNotCurrentlyCollected')" :state="sourceStates.ops.status === 'measured' ? 'partial' : sourceStates.ops.status" />
            <!-- 审查 #1:无样本显示「无样本」并转不可用态,绝不显示 0 ms(那等于断言"瞬时返回")。 -->
            <MetricCell :label="t('costCenter.text.firstTokenWait')" :value="ttftP95 == null ? t('costCenter.text.noSamples') : formatDuration(ttftP95)" :note="ttftP95 == null ? t('costCenter.text.noFirstTokenTimingRecordsInTheSelected') : t('costCenter.text.95OfRequestsWaitNoLongerThanThis')" :state="ttftP95 == null ? 'unavailable' : sourceStates.ops.status" accent="blue" />
          </div>

          <div class="cost-provenance-strip" tabindex="0" :class="{ 'has-default-warning': defaultCostProfileCount > 0, 'has-fallback-note': !!costFallbackNote }" :aria-label="t('costCenter.text.costDataBasis')">
            <div><CircleCheck :size="15" /><strong>{{ t('costCenter.text.usageSource') }}</strong><span>{{ connectionType === null ? t('costCenter.text.usageFromLocalCockpitRecordsExpensesEstimatedUsing') : connectionType === 'cliproxy' ? t('costCenter.text.usageFromCliproxyapiRecordsPriceBasedEstimatesNot') : t('costCenter.text.usageAndUserBillingFromSub2apiRecords') }}</span></div>
            <div class="cost-fee-settings" :class="{ 'is-warning': exchangeRate.source === 'fallback' }"><Calculator :size="15" /><strong>{{ t('costCenter.text.expenseSettings') }}</strong><span class="cost-fee-controls">{{ t('costCenter.text.1Usd') }} <input class="cost-rate-input" :aria-label="t('costCenter.text.usdExchangeRate')" type="number" step="0.01" min="4" max="10" :value="exchangeRate.rate.toFixed(2)" @change="handleRateOverride($event)" /> {{ t('costCenter.text.cny') }}<span v-if="exchangeRate.source === 'override'"> · <button type="button" class="cost-rate-clear" @click="clearRateOverride">{{ t('costCenter.text.restoreAutomatic') }}</button></span> {{ t('costCenter.text.estimateMultiplier') }}<input class="cost-rate-input cost-rate-input--multiplier" :aria-label="t('costCenter.text.estimateMultiplier2')" type="number" step="0.1" min="0.1" max="10" :value="cockpitCostMultiplier.toFixed(1)" @change="handleMultiplierOverride($event)" /></span></div>
            <div><TrendingUp :size="15" /><strong>{{ t('costCenter.text.expenseForecast') }}</strong><span>{{ t('costCenter.text.projectedFromRecentUsageActualExpensesMayVary') }}</span></div>
            <div><ReceiptText :size="15" /><strong>{{ t('costCenter.text.usageCostReference') }}</strong><span>{{ rangeLabel }} {{ connectionType === 'sub2api' ? t('costCenter.text.userBilling') : t('costCenter.text.estimatedUsageCost') }} {{ formatUsd(windowActualOutputUsd, 4) }}{{ t('costCenter.text.estimatedAccountExpense2') }} {{ formatUsd(windowAccountCostUsd, 4) }}{{ t('costCenter.text.usageCostReferenceNotProcurementPayments') }}</span></div>
            <div v-if="defaultCostProfileCount" class="is-warning"><TriangleAlert :size="15" /><strong>{{ defaultCostProfileCount }} {{ t('costCenter.text.accountsUseDefaultPlanEstimates') }}</strong><span>{{ t('costCenter.text.missingInformationUsesDefaultPlanPricesAndMultiplier') }}</span></div>
            <div v-if="costFallbackNote" class="is-warning"><TriangleAlert :size="15" /><strong>{{ t('costCenter.text.defaultCostMultiplierEnabled') }}</strong><span>{{ costFallbackNote }}</span></div>
          </div>

          <AssetCostOverview
            :total="formatCny(hasMeasuredData(sourceStates.accounts) ? totalAccruedCny : null, 2)"
            :total-label="assetLedgerState === 'measured' ? t('costCenter.text.cumulativeExpense') : unavailableValueLabel(sourceStates.accounts)"
            :total-note="t('costCenter.text.procurementAllocationAndAccountLossesNotAllExpenses', { value0: platformDonutModeLabel, value1: platformDonutLabel })"
            :source-label="connectionType === 'sub2api' ? 'Sub2API' : connectionType === 'cliproxy' ? 'CLIProxyAPI' : 'Cockpit'"
            :scope-label="`${assetScopeLabel} · ${currentAccountsReady ? currentAccounts.length : t('costCenter.text.noData')} ${sourceStates.accounts.status === 'stale' ? t('costCenter.text.accountsLatestSnapshot') : t('costCenter.text.currentAccounts')}`"
            :updated-label="lastUpdatedLabel"
            :active-count="currentAccountsReady ? activeAccounts.length : null"
            :account-count="currentAccountsReady ? currentAccounts.length : null"
          >
            <template #procurement>
              <div class="asset-metric-detail" :title="t('costCenter.text.enteredPurchasesTakePrecedenceMissingPurchasesUseDefault', { value0: amountCoverage(operatingSummary.fixedHourlyCny) })"><MetricCell :label="t('costCenter.text.procurementCost')" :value="formatKnownAmount(operatingSummary.fixedHourlyCny, 'CNY', 6, true)" :note="t('costCenter.text.accountPurchaseCostsAllocatedHourly', { value0: amountCoverage(operatingSummary.fixedHourlyCny) })" :title="financialBasis" :state="operatingState" accent="blue" /></div>
            </template>
            <template #loss>
              <div class="asset-metric-detail" :title="`${rangeLabel} · ${recordedLossNote}`"><MetricCell :label="t('costCenter.text.accountLosses')" :value="formatCny(windowImpairmentCny, 2)" :note="t('costCenter.text.recordedLossesIn', { value0: rangeLabel })" :state="windowImpairmentCny == null ? financePending ? 'loading' : 'unavailable' : financePending || financeError ? 'partial' : financialState" accent="gold" /></div>
            </template>
            <template #operations>
              <div class="asset-metric-detail" :title="t('costCenter.text.procurementAllocationUsageCostAccountLossesExpenseCredits', { value0: rangeLabel, value1: amountCoverage(operatingSummary.expenseCny) })"><MetricCell :label="t('costCenter.text.operatingExpense')" :value="formatKnownAmount(operatingSummary.expenseCny, 'CNY', 4)" :note="t('costCenter.text.accountExpenseUsageExpenseLossesCredits', { value0: amountCoverage(operatingSummary.expenseCny) })" :title="operatingBasis" :state="operatingState" accent="gold" /></div>
            </template>
            <template #budget>
              <div class="asset-metric-detail" :title="t('costCenter.text.recurringProcurementRate730hThisMonthSOutright')"><MetricCell :label="t('costCenter.text.monthlyProcurementBudget')" :value="formatCny(monthlyProcurementForecastCny, 2)" :note="t('costCenter.text.estimatedAccountPurchaseExpenseThisMonth')" :title="monthlyProcurementNote" :state="assetLedgerState === 'measured' ? 'estimated' : assetLedgerState" /></div>
            </template>
            <template #hourlyUsage>
              <div class="asset-metric-detail" :title="t('costCenter.text.windowAverageNotCashFlows', { value0: amountCoverage(operatingOutputSummary), value1: rangeLabel })"><MetricCell :label="connectionType === 'sub2api' ? t('costCenter.text.userBillingPerHour') : t('costCenter.text.usageValuationPerHour')" :value="formatKnownAmount(operatingRate(operatingOutputSummary), 'USD', 6, true)" :note="t('costCenter.text.hourlyAverageNotCash', { value0: amountCoverage(operatingOutputSummary), value1: rangeLabel })" :title="economicsSampleNote" :state="operatingOutputSummary.total == null ? 'partial' : operatingState" accent="gold" /></div>
            </template>
            <template #rolling>
              <div class="asset-metric-detail" :title="t('costCenter.text.sourceRecordedAmount', { value0: rollingTrendLabel, value1: trendCostPartialSuffix })"><MetricCell :label="t('costCenter.text.recentAverageExpense')" :value="formatRate(rollingOutputUsd, 'USD')" :note="t('costCenter.text.recentAverage', { value0: trendCostPartialSuffix })" :state="sourceStates.dashboard.status" accent="gold" /></div>
            </template>
            <template #hourlyTotal>
              <div class="asset-metric-detail" :title="t('costCenter.text.procurementAllocationPeriodUsageCost', { value0: amountCoverage(operatingSummary.hourlyExpenseCny) })"><MetricCell :label="t('costCenter.text.totalExpensePerHour')" :value="formatKnownAmount(operatingSummary.hourlyExpenseCny, 'CNY', 6, true)" :note="t('costCenter.text.accountExpenseUsageCost', { value0: amountCoverage(operatingSummary.hourlyExpenseCny) })" :title="t('costCenter.text.subscriptionApiRecordedValuesAreNotAddedTwice')" :state="operatingState" accent="blue" /></div>
            </template>
            <template #today>
              <div class="asset-metric-detail" :title="connectionType === null ? t('costCenter.text.todaySUsageEstimatedFromPricesAndCost') : connectionType === 'cliproxy' ? t('costCenter.text.todaySUsageEstimatedFromPricesAndCost2') : t('costCenter.text.basedOnPricesAndAccountMultipliersInToday')"><MetricCell :label="t('costCenter.text.todaySUsageExpense')" :value="formatUsd(todayAccountCostUsd, 3)" :note="connectionType === 'sub2api' ? t('costCenter.text.estimatedFromTodaySUsage') : t('costCenter.text.todaySUsageEstimateNotABill')" :state="sourceStates.todayStats.status" /></div>
            </template>
            <template #period>
              <div class="asset-metric-detail" :title="amountCoverage(operatingOutputSummary) + (connectionType === 'sub2api' ? t('costCenter.text.sameWindowBillingForAllAccountsNotCash') : t('costCenter.text.originalPriceEquivalentNotRevenueOrActualProcurement'))"><MetricCell :label="connectionType === 'sub2api' ? t('costCenter.text.periodUserBilling') : t('costCenter.text.periodUsageValuation')" :value="formatKnownAmount(operatingOutputSummary, 'USD', 4)" :note="amountCoverage(operatingOutputSummary) + (connectionType === 'sub2api' ? t('costCenter.text.periodBillingNotCashReceipts') : t('costCenter.text.usageValuationInTheSelectedPeriod'))" :state="sourceStates.rangeStats.status" /></div>
            </template>
            <template #accounts>
              <div class="asset-metric-detail" :title="!currentAccountsReady || sourceStates.accounts.status === 'stale' ? currentAccountHealthReason : quotaRemainingAverage == null ? sourceStates.accountUsage.reason : t('costCenter.text.windowAverageHeadroom', { value0: formatPercentOrDash(quotaRemainingAverage) })"><MetricCell :label="t('costCenter.text.availableAccounts')" :value="currentAccountsReady ? `${activeAccounts.length} / ${currentAccounts.length}` : t('costCenter.text.noData')" :note="!currentAccountsReady || sourceStates.accounts.status === 'stale' ? currentAccountHealthReason : t('costCenter.text.currentlySchedulableAccounts')" :state="currentAccountsReady ? sourceStates.accounts.status : 'unavailable'" /></div>
            </template>
            <template #unitCost>
              <div class="asset-metric-detail" :title="overviewUnitCost.unresolved ? t('costCenter.text.label5', { value0: overviewUnitCost.value, value1: overviewUnitCost.note }) : overviewUnitCost.note"><MetricCell :label="t('costCenter.text.expensePer1OfUsage')" :value="cnyPerBilledUsd != null ? `${formatCny(cnyPerBilledUsd, 4)}/USD` : overviewUnitCost.unresolved ? t('costCenter.text.awaitingCompleteAmounts') : overviewUnitCost.value" :note="overviewUnitCost.unresolved ? overviewUnitCost.note : t('costCenter.text.sameWindowExpenseUsageAmount')" :state="overviewUnitCost.partial ? 'partial' : operatingState" accent="blue" /></div>
            </template>
            <template #profit>
              <div class="asset-metric-detail" :title="connectionType === 'sub2api' ? t('costCenter.text.userBillingMinusOperatingExpenseCompleteProfitNot') : t('costCenter.text.thisSourceIsSelfUseConsumptionWithoutSales')"><MetricCell :label="t('costCenter.text.periodGrossProfitEstimated')" :value="connectionType !== 'sub2api' ? t('costCenter.text.notApplicable') : windowContributionCny == null ? t('costCenter.text.awaitingExpenseAttribution') : formatCny(windowContributionCny, 4)" :note="connectionType === 'sub2api' ? t('costCenter.text.billingExpenseCompleteProfitNotCalculatedWithMissing') : t('costCenter.text.selfUseConsumptionNoSalesRevenue')" :title="operatingBasis" :state="connectionType === 'sub2api' ? operatingState : 'unavailable'" accent="lime" /></div>
            </template>
            <template #payback>
              <div class="asset-metric-detail" :title="connectionType === 'sub2api' ? t('costCenter.text.sameWindowUserBillingOperatingExpenseNotProof') : t('costCenter.text.noSalesRevenueForSelfUseReturnRatio')"><MetricCell :label="t('costCenter.text.returnRatio')" :value="paybackRatio == null ? connectionType === 'sub2api' ? t('costCenter.text.awaitingCompleteAmounts') : t('costCenter.text.notApplicable') : formatPercent(paybackRatio)" :note="connectionType === 'sub2api' ? t('costCenter.text.billingExpenseNotCashRecovery') : t('costCenter.text.noReturnRatioForSelfUse')" :state="operatingState" accent="gold" /></div>
            </template>
            <template #paybackTime>
              <div class="asset-metric-detail" :title="connectionType === 'sub2api' ? t('costCenter.text.uncoveredWindowExpenseAverageWindowContributionNotA', { value0: projectedContributionHourlyCny == null ? '' : ` · ${formatRate(projectedContributionHourlyCny, 'CNY')}` }) : t('costCenter.text.noSalesRevenueForSelfUsePaybackPeriod')"><MetricCell :label="t('costCenter.text.estimatedPaybackTime')" :value="estimatedPaybackHours == null ? connectionType === 'sub2api' ? t('costCenter.text.awaitingCompleteAmounts') : t('costCenter.text.notApplicable') : estimatedPaybackHours <= 0 ? t('costCenter.text.paidBack') : t('costCenter.text.hours', { value0: formatPlainNumber(estimatedPaybackHours, 1) })" :note="connectionType === 'sub2api' ? t('costCenter.text.estimatedFromPeriodContributionNotAStableForecast') : t('costCenter.text.noPaybackPeriodInferredForSelfUse')" :state="operatingState" /></div>
            </template>
          </AssetCostOverview>

          <p v-if="unattributedWindowRequests || unassignedOperatingCount" class="cost-unassigned-note">{{ t('costCenter.text.unattributedUsageRateValue') }} {{ formatAmount(operatingSummary.unclassifiedUsageCostUsd, 'USD', 4) }}{{ t('costCenter.text.accountTypeMissingExcludedFromConfirmedExpenseDetails') }}</p>

          <!-- 渠道配额(资产总览口径):各渠道账号"用了多少"。默认走落盘快照,零外网请求。
               每条都带来源类型与数据时间戳;不可得显示"用量不可得"而不是 0%(P0-21)。
               审查 #10:读取失败时保留旧数据但**必须标出来**,不能让用户当成最新数据。 -->
          <div v-if="connectionType === null && quotaChannelSummaries.length" class="cost-quota-strip" :class="{ 'is-stale-error': quotaTrust.staleDueToError }" :aria-label="t('costCenter.text.channelQuotas')">
            <div class="cost-quota-strip__intro">
              <span>{{ t('costCenter.text.channelQuotas') }}</span>
              <strong>{{ t('costCenter.text.usageByChannel') }}</strong>
              <small>{{ t('costCenter.text.savedSnapshotsNoExternalRequests') }}<template v-if="quotaStaleCount"> · {{ quotaStaleCount }} {{ t('costCenter.text.possiblyStale') }}</template><template v-if="quotaUnavailableCount"> · {{ quotaUnavailableCount }} {{ t('costCenter.text.withUnavailableUsage') }}</template><template v-if="quotaTrust.staleDueToError"> · <b class="cost-quota-strip__failed">{{ t('costCenter.text.readFailedThisTime') }}</b></template></small>
              <!-- 审查 #10:失败提示 + 原文。数据照旧显示,但说清它是上次成功的。 -->
              <p v-if="quotaTrust.staleDueToError" class="cost-quota-strip__notice">
                <TriangleAlert :size="13" />
                <span>{{ quotaTrust.title }}</span>
                <small v-if="quotaTrust.detail">{{ quotaTrust.detail }}</small>
              </p>
            </div>
            <div v-for="q in quotaChannelSummaries" :key="q.channel" class="cost-quota-chip">
              <strong>{{ q.channel }}</strong>
              <span v-if="!q.hasSnapshot" class="cost-muted">{{ t('costCenter.text.noSnapshot') }}</span>
              <span v-else-if="q.worst == null" class="cost-muted">{{ t('costCenter.text.usageUnavailable') }}</span>
              <!-- 数据 ≥1 天没更新:百分比已不代表当前用量 → 转灰 + 明说年龄,不拿"剩余 100%"骗人 -->
              <span v-else-if="q.ageDays >= 1" class="cost-muted" :title="t('costCenter.text.channelQuotaHasNotUpdatedForDaysPercentages', { value0: q.ageDays })">
                {{ t('costCenter.text.remaining') }} {{ q.worst.toFixed(1) }}%<template v-if="q.ageLabel"> · {{ q.ageLabel }}</template>
              </span>
              <!-- 审查 #10:读取失败时同样转灰 —— 绿色/警告色都是对当前状态的正向断言 -->
              <span v-else-if="quotaTrust.staleDueToError" class="cost-muted" :title="t('costCenter.text.quotaReadFailedThisTimeThisPercentageIs')">
                {{ t('costCenter.text.remaining') }} {{ q.worst.toFixed(1) }}%
              </span>
              <span v-else :class="q.worst <= 20 ? 'cost-warning-text' : 'cost-lime'">{{ t('costCenter.text.remaining') }} {{ q.worst.toFixed(1) }}%</span>
              <small>{{ q.accountCount }} {{ t('costCenter.text.account3') }}<template v-if="q.stamp"> · {{ q.stamp }}</template></small>
            </div>
          </div>

          <!-- P0-15 合并口径状态标注。
               2026-09-12 已拍板:**按「天(UTC) × 模型」取两源 token 更大的那个源(不相加)**,
               故脚注从"待定"改为"已就绪"。合并层不可用时如实退回"待定",绝不伪造已定案。
               ⚠️ 本区**总额仍走 cockpit 直连口径** —— 窗口最长 30d,切换只带来 +20%
                  (全量 +71% 不适用于本页,别再拿那个数估影响)。明细在「API 接入」页。 -->
          <!-- 2026-09-16:本条取数(mergedUsage)只由 loadLedgerReconcile() 写入,而它的两个调用点
               都在 cockpit 分支内 —— sub2api/cliproxy 下 mergedUsage 恒为 null,该条会固定显示
               「多源对账未执行(非桌面运行时或调用失败)」,把用户引向"非桌面/调用失败"的错误排查方向。
               它是 cockpit 本地账本的专属信息,不属于三源共享面板。 -->
          <div v-if="connectionType === null" class="cost-import-result" :class="mergedUsage?.available ? 'is-success' : ''" style="margin: 0 0 12px;">
            <strong>{{ t('costCenter.text.mergedBasis') }}</strong> · {{ mergeBasisFootnote }}
            <small style="display:block; opacity:.72; margin-top:3px;">{{ mergedLongRatioHint }}</small>
          </div>

          <div class="cost-chart-row">
            <ChartPanel :title="connectionType === null ? t('costCenter.text.calculatedApiCostRate') : connectionType === 'cliproxy' ? t('costCenter.text.estimatedApiCostRate') : t('costCenter.text.apiOutputRate')" :caption="(connectionType === null ? t('costCenter.text.calculatedFromCockpitPerRequestUsageConvertedTo', { value0: costWindowCaption }) : connectionType === 'cliproxy' ? t('costCenter.text.cpaUsageEventsCatalogLocalReferencePricesConverted', { value0: costWindowCaption }) : t('costCenter.text.actualUsageLogsConvertedToH', { value0: costWindowCaption })) + trendCostPartialSuffix">
              <CostLineChart
                :labels="financialTrend.map((point) => formatTrendLabel(point.timestamp))"
                :series="[
                  { label: connectionType === null ? t('costCenter.text.calculatedCost') : connectionType === 'cliproxy' ? t('costCenter.text.estimatedCost') : t('costCenter.text.currentSampling'), data: trendActualCost, color: '#e0bd4e', fill: true },
                  { label: rollingTrendLabel, data: rollingTrendActualCost, color: '#b9e55a', dashed: true },
                ]"
                value-prefix="$"
                :state="trendFinancialState.status"
                :state-reason="trendFinancialReason"
              />
            </ChartPanel>
            <ChartPanel :title="t('costCenter.text.costRatesSourceReferenceValues')" :caption="t('costCenter.text.apiSourceLineIsSeparateCombinedLineIs', { value0: costWindowCaption })">
              <CostLineChart
                :labels="financialTrend.map((point) => formatTrendLabel(point.timestamp))"
                :series="[
                  { label: apiCostBasisLabel, data: trendStandardCost, color: '#d8b94d' },
                  { label: t('costCenter.text.procurementBaseline'), data: procurementBaseline, color: '#7eb6d8', dashed: true },
                  { label: t('costCenter.text.combinedOperatingAverage'), data: trendCombinedCost, color: '#b9e55a' },
                ]"
                value-prefix="¥"
                :state="combineSourceAvailability(trendFinancialState, sourceStates.accounts)"
                :state-reason="operatingBasis"
              />
            </ChartPanel>
          </div>

          <AdaptiveOperationsCharts
            :source-kind="costSourceKind"
            :ops-trend="opsTrend"
            :financial-trend="financialTrend"
            :financial-state="trendFinancialState.status"
            :financial-reason="trendFinancialReason"
            :query-window="connectionType === null && !cockpitCostFromRequestLog ? undefined : trendQueryWindow ?? undefined"
            :error-trend="opsErrorTrend"
            :economics="adaptiveEconomics"
            :cny-per-usd="exchangeRate.rate"
            :ops-bucket-hours="opsBucketHours"
            :procurement-hourly-cny="procurementHourlyCny"
            :ops-state="sourceStates.ops.status"
            :ops-reason="sourceStates.ops.reason"
            :account-health="currentAccountHealth"
            :account-health-reason="currentAccountHealthReason"
            :health-state="connectionType === 'cliproxy' && sourceStates.accounts.status === 'stale' ? 'stale' : healthChartState.status"
            :health-reason="currentAccountHealthReason"
          />

          <section class="cost-model-panel" aria-labelledby="model-cost-title">
            <div class="cost-model-panel__header">
              <div>
                <span>{{ t('costCenter.text.modelEconomics') }}</span>
                <h2 id="model-cost-title">{{ t('costCenter.text.modelCostAnalysis') }}</h2>
                <p>{{ modelCostWindowLabel }} · {{ modelCostBasisNote }}<span v-if="modelWindowDetached" class="cost-muted"> {{ t('costCenter.text.independentWindowToolbar') }} {{ rangeLabel }} {{ t('costCenter.text.label6') }}</span></p>
              </div>
              <div class="cost-model-controls">
                <!-- 2026-09-10 恢复双轨:模型区保留自己的统计窗口。
                     2026-09-05 曾砍掉它(当时模型窗口默认 1h 且不跟主窗口变),正确修法是
                     "默认跟随主窗口 + 可独立改",不是删选择器。 -->
                <label>
                  <span>{{ t('costCenter.text.timeRange') }}</span>
                  <select v-model="modelCostRange" :aria-label="t('costCenter.text.modelTimeRange')">
                    <option value="today">{{ t('costCenter.text.today2') }}</option>
                    <option value="1m">{{ t('costCenter.text.last1Minute') }}</option>
                    <option value="5m">{{ t('costCenter.text.last5Minutes') }}</option>
                    <option value="30m">{{ t('costCenter.text.last30Minutes') }}</option>
                    <option value="1h">{{ t('costCenter.text.last1Hour') }}</option>
                    <option value="6h">{{ t('costCenter.text.last6Hours') }}</option>
                    <option value="24h">{{ t('costCenter.text.last24Hours') }}</option>
                    <option value="7d">{{ t('costCenter.text.last7Days') }}</option>
                    <option value="30d">{{ t('costCenter.text.last30Days') }}</option>
                  </select>
                </label>
                <label>
                  <span>{{ t('costCenter.text.modelBasis') }}</span>
                  <!-- cockpit 的模型统计只走「单请求用量库按模型聚合」一条链路,下面 4 个选项
                       是 sub2api 的 model_source 参数,在 cockpit 下不生效 —— 置灰并如实标注。 -->
                  <select v-model="modelCostSource" :aria-label="t('costCenter.text.modelStatisticsBasis')" :disabled="modelCostControlsDisabled.source">
                    <option value="upstream">{{ t('costCenter.text.modelSentUpstream') }}</option>
                    <option value="response">{{ t('costCenter.text.upstreamResponseDeclaredModel') }}</option>
                    <option value="requested">{{ t('costCenter.text.userRequestedModel') }}</option>
                    <option value="mapping">{{ t('costCenter.text.requestedForwardedModelMapping') }}</option>
                  </select>
                </label>
                <label>
                  <span>{{ t('costCenter.text.modelAudit') }}</span>
                  <select v-model="modelAuditMismatchOnly" :aria-label="t('costCenter.text.upstreamResponseModelAuditFilter')" :disabled="modelCostControlsDisabled.mismatchOnly">
                    <option :value="false">{{ t('costCenter.text.allCalls') }}</option>
                    <option :value="true">{{ t('costCenter.text.mismatchesOnly') }}</option>
                  </select>
                </label>
                <label class="cost-model-controls__account">
                  <span>{{ t('costCenter.text.costAccount') }}</span>
                  <select v-model="modelCostAccountSelection" :aria-label="t('costCenter.text.modelCostAccount')" :disabled="modelCostControlsDisabled.account">
                    <!-- 措辞按数据源区分:cockpit 账号主数据没有"已删除"概念(stats 是历史累积快照),
                         它有的是"已移出当前池、仅保留历史累计"的历史账号,故不能沿用 sub2api 的"含已删除"。 -->
                    <option value="all">{{ connectionType === null ? t('costCenter.text.allAccountsIncludingHistorical') : connectionType === 'cliproxy' ? t('costCenter.text.allAccounts') : t('costCenter.text.allAccountHistoryIncludingDeleted') }}</option>
                    <option v-for="account in accounts" :key="account.id" :value="String(account.id)">
                      {{ account.name }} · {{ accountOriginLabel(account) }}
                    </option>
                  </select>
                </label>
              </div>
            </div>

            <div class="cost-pricing-status" :class="{ 'is-unavailable': connectionType === 'sub2api' ? !pricingStatus : !localCatalog?.available && !Object.keys(modelPricing).length }">
              <div>
                <span>{{ t('costCenter.text.priceCatalog') }}</span>
                <strong>{{ pricingCatalogLabel }}</strong>
                <small>{{ pricingCatalogDetail }}</small>
              </div>
              <button type="button" :disabled="pricingRefreshing || localCatalogBusy || localCatalog?.refreshing" @click="refreshPricingCatalog">
                <RefreshCcw :size="14" :class="{ 'cost-spin': pricingRefreshing || localCatalogBusy || localCatalog?.refreshing }" />
                {{ pricingRefreshing || localCatalogBusy || localCatalog?.refreshing ? t('costCenter.text.synchronizing') : t('costCenter.text.syncNow') }}
              </button>
            </div>

            <div class="cost-model-summary">
              <MetricCell :label="t('costCenter.text.models2')" :value="hasMeasuredData(sourceStates.models) ? formatInteger(modelCostSummary.modelCount) : unavailableValueLabel(sourceStates.models)" :note="modelCostAccountLabel" :state="sourceStates.models.status" />
              <MetricCell :label="connectionType === null ? t('costCenter.text.standardPriceCostCatalogLocalReference') : connectionType === 'cliproxy' ? t('costCenter.text.apiReferenceValueCatalogLocalPrice') : t('costCenter.text.standardBillingAmount')" :value="modelCostSummary.standardCost == null ? '—' : hasMeasuredData(sourceStates.models) ? formatUsd(modelCostSummary.standardCost, 5) : unavailableValueLabel(sourceStates.models)" :note="modelCostSummary.standardCost == null ? t('costCenter.text.allModelsLackPricesAndTheSourceHas') : modelCostSummary.standardCostPartial ? t('costCenter.text.modelsLackPricesTotalIncludesPricedPortionsOnly', { value0: modelCostSummary.unknownCostModelCount }) : connectionType === null ? t('costCenter.text.calculatedTotalUsingCatalogLocalReferencePricesNo') : connectionType === 'cliproxy' ? t('costCenter.text.catalogLocalReferencePriceEstimateCpaHasNo') : t('costCenter.text.standardBillingAmountInRequestRecords')" :state="modelCostSummary.standardCost == null ? 'unavailable' : modelCostSummary.standardCostPartial ? 'partial' : sourceStates.models.status" />
              <MetricCell :label="t('costCenter.text.estimatedAccountExpense')" :value="modelCostSummary.accountCost == null ? '—' : hasMeasuredData(sourceStates.models) ? formatUsd(modelCostSummary.accountCost, 5) : unavailableValueLabel(sourceStates.models)" :note="modelCostSummary.accountCost == null ? t('costCenter.text.accountRatesAndReferencePricesBothUnknown') : t('costCenter.text.notProcurementPaymentEvidenceNotAddedToSubscription', { value0: modelCostSummary.accountCostPartial ? t('costCenter.text.modelsUnpricedCalculatedPortionRetained', { value0: modelCostSummary.unknownAccountCostModelCount }) : '', value1: connectionType === 'sub2api' ? t('costCenter.text.sourcePriceSnapshotAccountMultiplier') : t('costCenter.text.localReferencePriceAppliedLocalMultiplier') })" :state="modelCostSummary.accountCost == null ? 'unavailable' : modelCostSummary.accountCostPartial ? 'partial' : 'estimated'" accent="blue" />
              <MetricCell :label="t('costCenter.text.actualUserBilling')" :value="modelCostSummary.revenueMissing ? '—' : hasMeasuredData(sourceStates.models) ? formatUsd(modelCostSummary.revenue, 5) : unavailableValueLabel(sourceStates.models)" :note="modelCostSummary.revenueMissing ? revenueMissingNote : 'usage_logs actual_cost'" :state="modelCostSummary.revenueMissing ? 'unavailable' : sourceStates.models.status" :accent="modelCostSummary.revenueMissing ? '' : 'gold'" />
              <MetricCell :label="t('costCenter.text.billingDifferenceRatio')" :value="modelCostSummary.grossProfitMissing ? '—' : hasMeasuredData(sourceStates.models) ? `${formatUsd(modelCostSummary.grossProfit, 5)} / ${modelCostSummary.grossMargin == null ? t('costCenter.text.noValidUserBilling') : formatPercent(modelCostSummary.grossMargin)}` : unavailableValueLabel(sourceStates.models)" :note="t('costCenter.text.userBillingEstimatedAccountExpenseProcurementUnallocatedNot')" :state="modelCostSummary.grossProfitMissing ? 'unavailable' : 'estimated'" />
            </div>

            <div class="cost-model-summary cost-model-audit-summary">
              <MetricCell :label="t('costCenter.text.auditableRequests')" :value="hasMeasuredData(sourceStates.modelAudit) ? formatInteger(modelAuditSummary.observedRequests) : unavailableValueLabel(sourceStates.modelAudit)" :note="hasMeasuredData(sourceStates.modelAudit) ? t('costCenter.text.requestsInWindow', { value0: formatInteger(modelAuditSummary.totalRequests) }) : sourceStates.modelAudit.reason" :state="sourceStates.modelAudit.status" />
              <MetricCell :label="t('costCenter.text.matchingModels')" :value="hasMeasuredData(sourceStates.modelAudit) ? formatInteger(modelAuditSummary.matchedRequests) : unavailableValueLabel(sourceStates.modelAudit)" :note="t('costCenter.text.responseDeclarationMatchesTheModelActuallySentUpstream')" :state="sourceStates.modelAudit.status" />
              <MetricCell :label="t('costCenter.text.substitutedModel')" :value="hasMeasuredData(sourceStates.modelAudit) ? formatInteger(modelAuditSummary.mismatchRequests) : unavailableValueLabel(sourceStates.modelAudit)" :note="modelAuditSummary.mismatchRate == null ? t('costCenter.text.noAuditableResponsesYet') : t('costCenter.text.ofObservedRequests', { value0: formatPercent(modelAuditSummary.mismatchRate) })" :state="sourceStates.modelAudit.status" accent="gold" />
              <MetricCell :label="t('costCenter.text.auditRecordMissing')" :value="hasMeasuredData(sourceStates.modelAudit) ? formatInteger(modelAuditSummary.unobservedRequests) : unavailableValueLabel(sourceStates.modelAudit)" :note="t('costCenter.text.oldRecordsOrModelAbsentFromResponse')" :state="sourceStates.modelAudit.status" />
              <MetricCell :label="t('costCenter.text.substitutedRequestCost')" :value="hasMeasuredData(sourceStates.modelAudit) ? formatUsd(modelAuditSummary.mismatchAccountCost, 6) : unavailableValueLabel(sourceStates.modelAudit)" :note="!hasMeasuredData(sourceStates.modelAudit) ? sourceStates.modelAudit.reason : t('costCenter.text.standard', { value0: modelAuditSummary.mismatchStandardCost == null ? '—' : formatUsd(modelAuditSummary.mismatchStandardCost, 6), value1: modelAuditSummary.mismatchRevenue == null ? t('costCenter.text.userBillingNotRecorded') : t('costCenter.text.userBilling2', { value0: formatUsd(modelAuditSummary.mismatchRevenue, 6) }) })" :state="sourceStates.modelAudit.status" accent="blue" />
            </div>

            <p v-if="connectionType !== 'sub2api'" class="cost-model-note">{{ t('costCenter.text.currentSourceDoesNotRecordUpstreamResponseModels') }}</p>

            <details class="cost-model-basis"><summary>{{ t('costCenter.text.modelAmountsHistoricalBasis') }}</summary>
            <p class="cost-model-note">
              {{ t('costCenter.text.modelTablesShowApiReferenceValuesSourceAccount') }}
            </p>
            <p class="cost-model-note">
              {{ t('costCenter.text.thisIsModelCallHistoryWithinTheSelected') }}
            </p>
            </details>
            <p v-if="modelStatsExactWindowFallback" class="cost-model-note cost-model-note--warning">
              {{ t('costCenter.text.currentBackendLacksTrustworthyExactBoundariesRealUsage') }} {{ rangeLabel }} {{ t('costCenter.text.toAvoidLabelingAllHistoryAsTheCurrent') }}
            </p>
            <p v-if="modelStatsCompatibilityTruncated" class="cost-model-note cost-model-note--warning">
              {{ t('costCenter.text.selectedWindowExceedsThe25000UsageLogs') }}
            </p>

            <p v-if="modelWindowReadFailed" class="cost-model-note cost-model-note--warning">{{ sourceStates.models.reason }}</p>
            <div class="cost-model-contribution">
              <div class="cost-panel-heading"><strong>{{ t('costCenter.text.modelExpenses') }}</strong><span>{{ modelCostSummary.revenueMissing ? t('costCenter.text.rateReference', { value0: revenueMissingNote }) : t('costCenter.text.sourceUserBillingSourceRateValueTheirDifference') }}</span></div>
              <ModelContributionChart :rows="modelCostRows" :state="sourceStates.models.status" :state-reason="sourceStates.models.reason" />
            </div>

            <div class="cost-model-table-wrap" tabindex="0" :aria-label="t('costCenter.text.modelCostTableHorizontallyScrollable')">
              <table class="cost-model-table">
                <thead>
                  <tr><th>{{ t('costCenter.text.model') }}</th><th>{{ t('costCenter.text.callTime') }}</th><th>{{ t('costCenter.text.requests') }}</th><th>{{ t('costCenter.text.inputTokens') }}</th><th>{{ t('costCenter.text.cacheHit') }}</th><th>{{ t('costCenter.text.outputTokens') }}</th><th>{{ connectionType === null ? t('costCenter.text.standardReferenceCatalogLocalPrice') : connectionType === 'cliproxy' ? t('costCenter.text.apiReferenceValue') : t('costCenter.text.standardChannelReferencePrice') }}</th><th>{{ t('costCenter.text.estimatedAccountExpense') }}</th><th>{{ t('costCenter.text.userBillingAmount') }}</th><th>{{ t('costCenter.text.billingDifferenceRatio') }}</th></tr>
                </thead>
                <tbody>
                  <tr v-for="row in modelCostRows" :key="row.model">
                    <td><strong>{{ row.model || t('costCenter.text.unknownModel') }}</strong><small>{{ connectionType === null ? t('costCenter.text.cockpitPerRequestUsageDatabaseByModel') : connectionType === 'cliproxy' ? t('costCenter.text.cpaUsageEventsAggregation') : modelCostSourceLabel }}</small></td>
                    <td><strong>{{ t('costCenter.text.last2') }} {{ formatModelTime(row.last_seen) }}</strong><small>{{ t('costCenter.text.first') }} {{ formatModelTime(row.first_seen) }}</small></td>
                    <td>{{ formatInteger(row.requests) }}<small v-if="row.failed_zero_token_requests">{{ t('costCenter.text.includes') }} {{ formatInteger(row.failed_zero_token_requests) }} {{ t('costCenter.text.failedRequestsLackValidTokens') }}</small></td>
                    <td>{{ formatTokens(row.input_tokens) }}</td>
                    <td><strong>{{ formatTokens(row.cache_read_tokens) }}</strong><small>{{ row.cache_hit_ratio === null ? t('costCenter.text.cacheHitRatioUnconfirmed') : row.cache_hit_ratio != null ? t('costCenter.text.inputCacheHit', { value0: formatPercent(row.cache_hit_ratio) }) : formatCacheHitRate(row.input_tokens, row.cache_read_tokens, row.cache_creation_tokens) }}</small></td>
                    <td>{{ formatTokens(row.output_tokens) }}</td>
                    <td><template v-if="row.standardCost == null"><strong class="cost-unknown-value">{{ t('costCenter.text.costUnknown') }}</strong><small class="cost-muted">{{ t('costCenter.text.noUnitPriceOrSourceEstimate') }}</small></template><template v-else><strong>{{ formatUsd(row.standardCost, 6) }}</strong><small v-if="row.pricingMissing" class="cost-warning-text">{{ t('costCenter.text.missingUsageOrPrice') }}</small><small v-else>{{ connectionType === null ? t('costCenter.text.calculatedUsingCatalogLocalReferencePrices') : connectionType === 'cliproxy' ? t('costCenter.text.catalogLocalReferencePriceEstimateNoChannelPrices') : t('costCenter.text.priceCatalogChannelPrice') }}</small></template></td>
                    <td><template v-if="row.accountCost == null"><strong class="cost-unknown-value">{{ t('costCenter.text.costUnknown') }}</strong><small class="cost-muted">{{ t('costCenter.text.noUnitPriceOrSourceEstimate') }}</small></template><template v-else><strong>{{ formatUsd(row.accountCost, 6) }}</strong>
                      <small v-if="connectionType !== 'sub2api'" class="cost-warning-text">{{ t('costCenter.text.referencePriceLocalMultiplierEstimateNotABill') }}</small><small v-else-if="row.accountCostEstimated" class="cost-warning-text">{{ t('costCenter.text.legacyRecordsFallBackToStandardPrices') }}</small><small v-else>{{ t('costCenter.text.accountRateSnapshot') }}</small></template></td>
                    <td><strong :class="{ 'cost-unknown-value': row.revenueMissing }">{{ row.revenueMissing ? '—' : formatUsd(row.revenue, 6) }}</strong><small :class="{ 'cost-muted': row.revenueMissing }">{{ row.revenueMissing ? revenueMissingNote : 'actual_cost' }}</small></td>
                    <td><strong :class="row.revenueMissing || row.grossProfit == null ? 'cost-unknown-value' : row.grossProfit >= 0 ? 'cost-lime' : 'cost-warning-text'">{{ row.revenueMissing || row.grossProfit == null ? '—' : formatUsd(row.grossProfit, 6) }}</strong><small :class="{ 'cost-muted': row.revenueMissing }">{{ row.revenueMissing ? revenueMissingNote : row.grossMargin == null ? t('costCenter.text.noValidRevenue') : formatPercent(row.grossMargin) }}</small></td>
                  </tr>
                  <tr v-if="modelCostRows.length === 0"><td colspan="10" class="cost-empty-row">{{ modelCostEmptyLabel }}</td></tr>
                </tbody>
              </table>
            </div>

            <div class="cost-route-heading">
              <div><strong>{{ t('costCenter.text.modelCallDetails') }}</strong><span :class="{ 'cost-warning-text': modelRoutesTruncated }">{{ routeTableHint }}</span></div>
            </div>
            <div class="cost-model-table-wrap" tabindex="0" :aria-label="t('costCenter.text.recordedModelChannelEndpointDetailsHorizontallyScrollable')">
              <table class="cost-model-table cost-route-table">
                <thead>
                  <tr><th>{{ t('costCenter.text.requestedForwardedModel') }}</th><th>{{ t('costCenter.text.responseModelAudit') }}</th><th>{{ t('costCenter.text.callTime') }}</th><th>{{ t('costCenter.text.channel') }}</th><th>{{ t('costCenter.text.account3') }}</th><th>{{ t('costCenter.text.group') }}</th><th>{{ t('costCenter.text.inboundEndpoint') }}</th><th>{{ t('costCenter.text.upstreamEndpoint') }}</th><th>{{ t('costCenter.text.currentUnitPrice') }}</th><th>{{ t('costCenter.text.requests') }}</th><th>{{ t('costCenter.text.tokensCache') }}</th><th>{{ t('costCenter.text.referenceExpenseEstimatedCost') }}</th></tr>
                </thead>
                <tbody>
                  <tr v-for="routeRow in visibleModelRoutes" :key="routeRow.key">
                    <td><strong>{{ routeRow.requestedModel }}<template> → {{ routeRow.upstreamModel ?? t('costCenter.text.notRecorded') }}</template></strong><small>{{ routeRow.mappingChain }}</small></td>
                    <td><strong>{{ routeRow.upstreamResponseModel || t('costCenter.text.notRecorded') }}</strong><small class="cost-audit-badge" :class="`is-${routeRow.modelAuditStatus}`">{{ modelAuditStatusLabel(routeRow) }}</small></td>
                    <td><strong>{{ t('costCenter.text.last2') }} {{ formatModelTime(routeRow.lastSeen) }}</strong><small>{{ t('costCenter.text.first') }} {{ formatModelTime(routeRow.firstSeen) }}</small></td>
                    <td><strong>{{ routeRow.channelName || (connectionType === 'cliproxy' ? t('costCenter.text.channelNotRecordedBySource') : t('costCenter.text.unknown')) }}</strong><small>{{ routeRow.channelId == null ? t('costCenter.text.sourceHasNoChannelRecords') : t('costCenter.text.channelId', { value0: routeRow.channelId }) }}</small></td>
                    <td><strong>{{ routeRow.accountName || t('costCenter.text.unknown') }}</strong><small>{{ routeRow.accountId == null ? t('costCenter.text.historicalRecords') : t('costCenter.text.accountId', { value0: routeRow.accountId }) }}</small></td>
                    <td><strong>{{ routeRow.groupName || (connectionType === 'cliproxy' ? t('costCenter.text.groupNotRecordedBySource') : t('costCenter.text.unknown')) }}</strong><small>{{ routeRow.groupLabel ?? (routeRow.groupId == null ? t('costCenter.text.sourceHasNoGroupRecords') : t('costCenter.text.groupId', { value0: routeRow.groupId })) }}</small></td>
                    <td><strong>{{ routeRow.inboundEndpoint || '—' }}</strong><small>{{ routeRow.inboundEndpoint ? t('costCenter.text.clientEntryPoint') : t('costCenter.text.sourceDidNotRecordInboundEndpoint') }}</small></td>
                    <td><strong>{{ routeRow.upstreamEndpoint || '—' }}</strong><small>{{ routeRow.upstreamEndpoint ? t('costCenter.text.actualUpstreamPath') : t('costCenter.text.sourceDidNotRecordUpstreamEndpoint') }}</small></td>
                    <td>
                      <template v-if="routeRow.priceEvidence?.length">
                        <strong v-if="routeRow.priceEvidence.length === 1">{{ t('costCenter.text.in') }} {{ formatMoney(routeRow.priceEvidence[0].inputPerMillion, routeRow.priceEvidence[0].currency === 'CNY' ? 'CNY' : 'USD', 4) }}{{ t('costCenter.text.mOut') }} {{ formatMoney(routeRow.priceEvidence[0].outputPerMillion, routeRow.priceEvidence[0].currency === 'CNY' ? 'CNY' : 'USD', 4) }}/M</strong>
                        <details class="cost-route-prices"><summary>{{ routeRow.priceEvidence.length }} {{ t('costCenter.text.conditionalReferencePrices') }}</summary>
                          <div v-for="(quote, quoteIndex) in routeRow.priceEvidence" :key="quoteIndex">
                            <strong>{{ quote.pricingProvider }} · {{ monitorMode(quote.mode) }} {{ quote.quoteKind === 'scenario' ? t('costCenter.text.possiblePrices') : t('costCenter.text.referencePrices') }}</strong>
                            <small>{{ quote.currency || 'USD' }}{{ t('costCenter.text.mInput') }} {{ quote.inputPerMillion }} {{ t('costCenter.text.output') }} {{ quote.outputPerMillion }} {{ t('costCenter.text.cacheRead') }} {{ quote.cachedPerMillion ?? t('costCenter.text.unknown') }}</small>
                            <small>{{ t('costCenter.text.cacheWrite') }} {{ quote.cacheWritePerMillion ?? t('costCenter.text.noTierSplit') }} · 5m {{ quote.cacheWrite5mPerMillion ?? t('costCenter.text.unknown') }} / 1h {{ quote.cacheWrite1hPerMillion ?? t('costCenter.text.unknown') }}</small>
                            <small>{{ monitorContext(quote.contextTier) }}{{ quote.timeBand ? ' · ' + quote.timeBand : '' }} · {{ quote.usedForCost ? t('costCenter.text.usedForThisRowSReferenceAmount') : t('costCenter.text.alternativeReferenceExcludedFromThisRowSAmount') }}</small>
                            <small>{{ quote.checkedAt }} · {{ quote.catalogRevision || quote.version }}</small>
                          </div>
                        </details>
                      </template>
                      <template v-else><strong>{{ t('costCenter.text.in') }} {{ formatUsdPerMillion(resolveRoutePricing(routeRow)?.input_price) }} {{ t('costCenter.text.out') }} {{ formatUsdPerMillion(resolveRoutePricing(routeRow)?.output_price) }}</strong><small>{{ t('costCenter.text.cacheWrite') }} {{ formatUsdPerMillion(resolveRoutePricing(routeRow)?.cache_write_price) }} {{ t('costCenter.text.hit') }} {{ formatUsdPerMillion(resolveRoutePricing(routeRow)?.cache_read_price) }} · {{ routePricingSource(routeRow) }}</small></template>
                    </td>
                    <td>{{ formatInteger(routeRow.requests) }}<small v-if="routeRow.failedZeroTokenRequests">{{ formatInteger(routeRow.failedZeroTokenRequests) }} {{ t('costCenter.text.failedRequestsLackValidTokens') }}</small></td>
                    <td><strong>{{ formatTokens(routeRow.totalTokens) }}</strong><small>{{ t('costCenter.text.cache') }} {{ formatTokens(routeRow.cacheReadTokens) }}</small></td>
                    <td><template v-if="routeRow.standardCost == null || routeRow.costUnknown"><strong v-if="routeRow.knownStandardCost != null">{{ formatUsd(routeRow.knownStandardCost, 6) }} / {{ formatUsd(routeRow.knownAccountCost, 6) }}</strong><strong v-else class="cost-unknown-value">{{ t('costCenter.text.costUnknown') }}</strong><small class="cost-muted">{{ routeRow.knownStandardCost != null ? t('costCenter.text.calculatedPortionOtherUsageLacksCompletePricingConditions') : routeRow.costUnknown ? t('costCenter.text.insufficientPricingConditionsAndNoSourceEstimate') : t('costCenter.text.thisRecordLacksACostField') }}</small></template><template v-else><strong>{{ formatUsd(routeRow.standardCost, 6) }} / {{ formatUsd(routeRow.accountCost, 6) }}</strong><small>{{ routeCostBasisLabel(routeRow, connectionType) }}</small></template></td>
                  </tr>
                  <tr v-if="visibleModelRoutes.length === 0"><td :colspan="routeColumnCount" class="cost-empty-row">{{ modelRouteEmptyLabel }}</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <div class="cost-bottom-row">
            <ChartPanel :title="t('costCenter.text.recordedRequestVolumeTrend')" :caption="connectionType === null ? t('costCenter.text.cockpitPerRequestDatabaseLocalLogs', { value0: requestWindowCaption }) : connectionType === 'cliproxy' ? t('costCenter.text.cpaUsageEventsOpsRequestBucketsLocalLogs', { value0: requestWindowCaption }) : t('costCenter.text.usageLogsOpsRequestBucketsCockpitPerRequest', { value0: requestWindowCaption })" class="cost-score-panel">
              <CostLineChart
                :labels="qualityTrendLabels"
                :series="[
                  { label: t('costCenter.text.recordedRequests'), data: requestVolumeTrend, color: '#b9e55a', fill: true },
                  { label: t('costCenter.text.movingAverage'), data: movingAverage(requestVolumeTrend, requestSmoothingPoints), color: '#83b7d3', dashed: true },
                ]"
                :state="opsOverview ? sourceStates.ops.status : sourceStates.dashboard.status"
                :state-reason="opsOverview ? sourceStates.ops.reason : sourceStates.dashboard.reason"
              />
            </ChartPanel>
            <div class="cost-distribution-panel">
              <div class="cost-panel-heading"><strong>{{ t('costCenter.text.upstreamParticipation') }}</strong><span>{{ rangeLabel }} {{ t('costCenter.text.savedRequests') }}</span></div>
              <p class="cost-model-note">{{ participationAssignmentNote }}</p>
              <div class="cost-distribution-panel__body">
                <div class="cost-donut cost-donut--small" :style="{ background: accountDonutBackground }">
                  <div><strong>{{ formatInteger(participationRequestTotal) }}</strong><span>{{ t('costCenter.text.windowCalls') }}</span></div>
                </div>
                <ol class="cost-ranking-list">
                  <li v-for="item in accountDistribution" :key="item.id">
                    <span class="cost-swatch" :style="{ background: item.color }"></span>
                    <div><strong>{{ item.name }}</strong><small>{{ item.isUnattributed ? t('costCenter.text.requestsHaveNoAccountIdNotCountedAs', { value0: formatInteger(item.value) }) : t('costCenter.text.procurement', { value0: formatRate(item.hourlyCost, 'CNY'), value1: item.platform }) }}</small></div>
                    <b>{{ formatPercent(item.share) }}</b>
                  </li>
                </ol>
              </div>
            </div>
          </div>
        </section>

        <section v-else-if="activePanel === 'upstreams'" class="cost-workspace cost-upstreams" aria-labelledby="upstream-title">
          <div class="cost-page-heading">
            <div>
              <span>{{ t('costCenter.text.upstreamAssets') }}</span>
              <h2 id="upstream-title">{{ t('costCenter.text.upstreamAssetsLiveCosts') }}</h2>
              <p>{{ t('costCenter.text.accountQualitySchedulingProcurementAnd') }}{{ connectionType === null ? t('costCenter.text.calculatedCost') : connectionType === 'cliproxy' ? t('costCenter.text.estimatedCost') : t('costCenter.text.output2') }}{{ t('costCenter.text.inOneOperationsView') }}</p>
            </div>
            <div class="cost-page-heading__actions">
              <button v-if="desktopMode" type="button" class="cost-primary-button cost-primary-button--outline" @click="openAccountPurchase">
                <ShoppingBag :size="16" /> {{ t('costCenter.text.procurementAccounts') }} <ExternalLink :size="12" />
              </button>
              <button v-if="connectionType === 'sub2api'" type="button" class="cost-primary-button" @click="goToAccounts"><Plus :size="17" /> {{ t('costCenter.text.addUpstream') }}</button>
              <button v-else-if="connectionType === 'cliproxy'" type="button" class="cost-primary-button" @click="activePanel = 'cliproxy-manage'"><Plus :size="17" /> {{ t('costCenter.text.addUpstreamManagement') }}</button>
              <label v-if="connectionType === null" class="cost-primary-button cost-primary-button--outline" :class="{ 'is-loading': importing }">
                <LoaderCircle v-if="importing" :size="16" class="cost-spin" />
                <Upload :size="16" v-else />
                <span>{{ importing ? t('costCenter.text.importing') : t('costCenter.text.importAccounts') }}</span>
                <input type="file" accept=".json" :disabled="importing" @change="handleImportFile" hidden />
              </label>
            </div>
          </div>

          <div class="cost-table-tools">
            <div class="cost-platform-tabs" role="tablist" :aria-label="t('costCenter.text.platformFilter')">
              <button
                v-for="item in upstreamProviderTabs"
                :key="item.key"
                type="button"
                role="tab"
                :class="{ active: platformFilter === item.key }"
                :aria-selected="platformFilter === item.key"
                @click="platformFilter = item.key"
              >
                <span>{{ item.label }}</span>
                <small>{{ item.count }}</small>
              </button>
            </div>
            <span class="cost-refresh-stamp">{{ t('costCenter.text.lastRefreshed') }}{{ lastUpdatedLabel }} {{ t('costCenter.text.last') }} {{ hasMeasuredData(activitySourceState) ? formatInteger(totalObservedRequests) : t('costCenter.text.noData') }} {{ t('costCenter.text.requests2') }}</span>
            <label class="cost-search"><Search :size="15" /><input v-model.trim="searchQuery" type="search" :placeholder="t('costCenter.text.findAccountsGroupsOrNotes')" /></label>
          </div>

          <div class="cost-ranking-bar" :aria-label="t('costCenter.text.upstreamLiveRankingControls')">
            <div class="cost-ranking-bar__title">
              <Trophy :size="16" />
              <div><strong>{{ t('costCenter.text.liveRanking') }}</strong><span>{{ t('costCenter.text.ranksOnlyAccountsWithActualRequestProbeOr') }}</span></div>
            </div>
            <label class="cost-ranking-select">
              <span>{{ t('costCenter.text.rankingBasis') }}</span>
              <!-- ★ 2026-09-25:选项标签跟随**所选窗口**(`rankingValue` 走 `row.window ?? row.today`),
                   此前写死「今日」,而排序实际按 7d/30d 排 ⇒ 标签与行为不符。
                   所选时间内无记录时排序键回退今日用量(不是展示值),这点写进 title 如实说明。 -->
              <select v-model="rankingMetric" :aria-label="t('costCenter.text.rankingBasis')" :title="t('costCenter.text.sortedByAccountsWithoutRecordsInThisPeriod', { value0: rangeLabel })">
                <option value="score">{{ t('costCenter.text.accountScore') }}</option>
                <option value="reliability">{{ t('costCenter.text.availability') }}</option>
                <option value="output">{{ rangeLabel }} API {{ connectionType === null ? t('costCenter.text.calculatedCost') : connectionType === 'cliproxy' ? t('costCenter.text.estimatedCost') : t('costCenter.text.output2') }}</option>
                <option value="requests">{{ rangeLabel }} {{ t('costCenter.text.requestVolume') }}</option>
                <option value="cost">{{ rangeLabel }} {{ t('costCenter.text.accountCost') }}</option>
                <option value="latency">{{ t('costCenter.text.connectionTestTotalDuration') }}</option>
              </select>
            </label>
            <label v-if="historicalOrphanCount" class="cost-check-label cost-ranking-bar__historical" :title="connectionType === 'cliproxy' ? t('costCenter.text.historicalUsageIdentityOnlyNotProofOfCurrent') : t('costCenter.text.removedFromCurrentAccountPoolHistoricalCumulativeUsage')">
              <input v-model="showHistoricalAccounts" type="checkbox" />
              <span>{{ connectionType === 'cliproxy' ? t('costCenter.text.includeUsageIdentities') : t('costCenter.text.includeHistoricalAccounts') }}{{ t('costCenter.text.label7') }}{{ historicalOrphanCount }}{{ t('costCenter.text.label6') }}</span>
            </label>
            <span class="cost-ranking-bar__summary">{{ t('costCenter.text.showing') }} {{ upstreamRows.length }} {{ t('costCenter.text.accounts2') }}<span v-if="rankedUpstreamCount"> {{ t('costCenter.text.ranked') }} {{ rankedUpstreamCount }} {{ t('costCenter.text.1') }}{{ upstreamRows[0].account.name }}</span><span v-else> {{ t('costCenter.text.insufficientRankingEvidenceCurrently') }}</span></span>
          </div>

          <div class="cost-selection-bar" :aria-label="t('costCenter.text.upstreamAccountBulkActions')">
            <label class="cost-check-label">
              <input type="checkbox" :checked="allVisibleAccountsSelected" :indeterminate="someVisibleAccountsSelected && !allVisibleAccountsSelected" @change="toggleSelectAllVisible" />
              <span>{{ t('costCenter.text.selectCurrentFilteredResults') }}</span>
            </label>
            <span class="cost-selection-count">{{ t('costCenter.text.selected') }} {{ selectedAccountIds.size }} {{ t('costCenter.text.accounts2') }}</span>
            <button type="button" class="cost-primary-button cost-primary-button--outline" :disabled="selectedAccountIds.size === 0" @click="openBulkCostProfile">
              <Settings2 :size="16" />
              {{ t('costCenter.text.bulkEditCostSettings') }}
            </button>
            <button v-if="selectedAccountIds.size" type="button" class="cost-text-button" @click="clearSelection">{{ t('costCenter.text.clearSelection') }}</button>
          </div>

          <p class="cost-table-scroll-hint">
            <ArrowLeftRight :size="14" />
            {{ t('costCenter.text.scrollHorizontallyToViewAll') }} {{ upstreamColumnCount }} {{ t('costCenter.text.columns') }}
          </p>

          <div class="cost-data-table-wrap" tabindex="0" :aria-label="t('costCenter.text.upstreamAssetTableHorizontallyScrollable')">
            <table class="cost-data-table">
              <colgroup>
                <col class="cost-col-select" /><col class="cost-col-account" /><col class="cost-col-status" />
                <col class="cost-col-quota" /><col class="cost-col-score" /><col class="cost-col-priority" />
                <col class="cost-col-date" /><col class="cost-col-amount" /><col class="cost-col-amount" /><col class="cost-col-amount" /><col class="cost-col-amount" />
                <col class="cost-col-amount" /><col class="cost-col-latency" /><col class="cost-col-state" /><col class="cost-col-groups" /><col class="cost-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th class="cost-select-column">{{ t('costCenter.text.select') }}</th><th>{{ t('costCenter.text.account3') }}</th><th>{{ t('costCenter.text.status') }}</th><th>{{ t('costCenter.text.usageWindow') }}</th><th>{{ t('costCenter.text.schedulingScore') }}</th><th>{{ t('costCenter.text.priority') }}</th><th>{{ t('costCenter.text.added') }}</th><th>{{ t('costCenter.text.procurementCostHour') }}</th><th>{{ t('costCenter.text.cumulativeCost') }}</th><th>{{ costWindowCaption }} {{ t('costCenter.text.accountCost') }}</th><th>{{ connectionType === null ? t('costCenter.text.calculatedApiCost') : connectionType === 'cliproxy' ? t('costCenter.text.estimatedApiCost') : t('costCenter.text.apiOutput') }}</th><th>{{ t('costCenter.text.requestsTokens') }}</th><th>{{ t('costCenter.text.connectionTestTotalDuration') }}</th><th>{{ t('costCenter.text.currentErrorsRateLimits') }}</th><th>{{ t('costCenter.text.group') }}</th><th>{{ t('costCenter.text.actions') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in upstreamRows" :key="row.account.id" :class="[`status-${row.currentState.state}`, { selected: selectedAccount?.id === row.account.id, 'row-selected': selectedAccountIds.has(row.account.id) }]">
                  <td class="cost-select-column"><input type="checkbox" :checked="selectedAccountIds.has(row.account.id)" :aria-label="t('costCenter.text.select2', { value0: row.account.name })" @change="toggleAccountSelection(row.account.id)" /></td>
                  <td class="cost-account-cell">
                    <div class="cost-account-primary"><span class="cost-rank-badge" :class="{ 'is-unranked': row.rank == null }" :data-rank="row.rank || undefined">{{ row.rank == null ? t('costCenter.text.unranked') : `#${row.rank}` }}</span><strong :title="row.account.name">{{ row.account.name }}</strong></div>
                    <small>#{{ row.account.id }} · {{ accountOriginLabel(row.account) }} / {{ row.isHistorical ? row.account.extra?.cliproxy_identity_source === 'usage_only' ? t('costCenter.text.noMatchingCurrentManagedAccount') : t('costCenter.text.removedFromCurrentPool') : row.plan }}</small>
                  </td>
                  <td><StatusLabel v-if="row.isHistorical" state="historical" :label="row.account.extra?.cliproxy_identity_source === 'usage_only' ? t('costCenter.text.usageIdentity2') : t('costCenter.text.historicalIdentity')" /><StatusLabel v-else :state="row.currentState.state" :label="row.currentState.label" /></td>
                  <td>
                    <div v-if="row.usage" class="cost-usage-windows">
                      <span v-for="quota in row.quotaWindows" :key="quota.key" :data-usage-window="quota.key" :data-historical="quota.state.historical">
                        <b :title="quota.label">{{ quota.label }}</b>
                        <i><em :style="{ width: `${utilizationBarWidth(quota.state.utilization)}%` }" :data-grade="quota.state.historical ? 'unknown' : quotaGrade(quota.state.utilization)"></em></i>
                        <strong :data-grade="quota.state.historical ? 'unknown' : quotaGrade(quota.state.utilization)">{{ formatUtilization(quota.state.utilization) }}</strong>
                        <small>{{ !quota.provided ? t('costCenter.integration.quotaPeriodNotReported') : quota.state.resetState === 'expired' ? t('costCenter.integration.quotaWaitingUpdate') : formatUsageReset(quota.state.resetAt) }}</small>
                        <small v-if="quota.provided" class="cost-quota-stamp"><template v-if="quota.state.historical && quota.state.utilization != null">{{ t('costCenter.integration.quotaRecordedValue', { value: formatUtilization(quota.state.utilization) }) }} · </template>{{ quota.state.updatedAt ? `${t('costCenter.text.updated')} ${formatCompactDate(quota.state.updatedAt)}` : t('costCenter.text.updateTimeUnknown') }}</small>
                        <small v-if="quota.state.sourceError" class="cost-quota-error" :title="quota.state.sourceError">{{ t('costCenter.integration.quotaPreviousReadFailed') }}</small>
                      </span>
                      <small v-if="!row.quotaWindows.length">{{ t('costCenter.text.noWindow') }}</small>
                    </div>
                    <small v-else>{{ sourceStates.accountUsage.status === 'unavailable' ? t('costCenter.text.noData3', { value0: sourceStates.accountUsage.reason }) : sourceStates.accountUsage.status === 'stale' ? t('costCenter.text.oldDataUnavailable') : sourceStates.accountUsage.status === 'loading' ? t('costCenter.text.loadingUsageWindow') : connectionType === 'cliproxy' && data.cliproxyQuotaDataState.value === 'reported' ? t('costCenter.text.thisIdentityDidNotReportAQuotaWindow') : t('costCenter.text.awaitingSynchronization') }}</small>
                  </td>
                  <td><span v-if="row.scoreRaw != null" class="cost-score" :data-grade="scoreGrade(row.score)">{{ row.score.toFixed(1) }}</span><span v-else-if="row.scoreBasis === 'derived'" class="cost-score is-derived">{{ row.score.toFixed(1) }}<em class="cost-derived-tag">{{ t('costCenter.text.inferred') }}</em></span><span v-else class="cost-score is-unavailable">{{ t('costCenter.text.noData') }}</span><small>{{ row.scoreRaw == null ? (row.scoreBasis === 'derived' ? t('costCenter.text.inferredFromAccountStatusNotABackendScheduling') : t('costCenter.text.backendDoesNotProvideAnAccountSchedulingScore')) : `${row.scoreRaw.toFixed(2)} / ${row.scoreMax.toFixed(2)} · ${row.account.scheduler_score?.sticky_weighted_enabled ? 'sticky' : 'base'}` }}</small></td>
                  <td><template v-if="row.account.priority == null"><strong class="cost-unknown-value">—</strong><small>{{ connectionType === 'cliproxy' ? t('costCenter.text.cpaHasNoAccountPriorityConcept') : connectionType === null ? t('costCenter.text.noRoutingRuleConfiguredSourceDoesNotExpress') : t('costCenter.text.sourceDoesNotProvidePriority') }}</small></template><template v-else><strong>{{ row.account.priority }}</strong><small>{{ connectionType === 'sub2api' ? t('costCenter.text.lowerValuesTakePriority') : row.account.priority === 2 ? t('costCenter.text.highest') : row.account.priority === 0 ? t('costCenter.text.lowest') : t('costCenter.text.normal') }}</small></template></td>
                  <td><strong>{{ formatCompactDate(row.account.created_at) }}</strong><small>{{ row.account.extra?.cliproxy_identity_source === 'usage_only' ? t('costCenter.text.firstUsageRecord') : row.lossState?.active ? t('costCenter.text.finalizedAt', { value0: formatCompactDate(row.lossState.occurred_at) }) : t('costCenter.text.hBilled', { value0: row.elapsedHours.toFixed(1) }) }}</small></td>
                  <td>
                    <template v-if="row.financial.hasRecorded"><strong :class="procurementStrongClass(row.financial.rateEstimated || row.financial.partial ? 'estimated' : 'measured')">{{ row.hourlyCost == null ? t('costCenter.text.allocationIncomplete') : formatRate(row.hourlyCost, 'CNY') }}</strong><small>{{ t('costCenter.text.procurementLedgerAccrual') }}{{ row.financial.rateEstimated ? t('costCenter.text.estimateForUncoveredPeriods') : '' }}{{ row.financial.partial ? t('costCenter.text.someRecordsNeedInformation') : '' }}</small></template>
                    <template v-else><strong :class="procurementStrongClass(row.procurementRateBasis)">{{ row.isHistorical ? '—' : assetLedgerState === 'unavailable' ? t('costCenter.text.noData') : row.billingMode === 'metered' && row.profile.source !== 'custom' ? (meteredHourlyCny(row) != null ? formatRate(meteredHourlyCny(row), 'CNY') : t('costCenter.text.byTokens')) : formatRate(row.hourlyCost, 'CNY') }}<em v-if="row.procurementRateBasis === 'estimated'" class="cost-derived-tag">{{ t('costCenter.text.inferred') }}</em></strong><small>{{ row.isHistorical ? row.account.extra?.cliproxy_identity_source === 'usage_only' ? t('costCenter.text.noMatchingCurrentManagedAccountNoPurchasesEntered') : t('costCenter.text.removedFromCurrentPoolNoProcurementProfile') : assetLedgerState === 'unavailable' ? sourceStates.accounts.reason : row.billingMode === 'metered' ? t('costCenter.text.windowMeteredRateAverageFixedExpensesSeparate') : t('costCenter.text.costSettings', { value0: row.profile.source === 'custom' ? t('costCenter.text.userDefined') : t('costCenter.text.planPriceEstimate') }) }}</small></template>
                  </td>
                  <td>
                    <template v-if="row.financial.hasRecorded"><strong :class="procurementStrongClass(row.financial.lifetimeEstimated || row.financial.partial ? 'estimated' : 'measured')">{{ formatCny(row.accrued, 3) }}</strong><small>{{ t('costCenter.text.cumulativeAccrualLossesExpenseCredits') }}{{ row.financial.lifetimeEstimated ? t('costCenter.text.includesUncoveredPeriodEstimates') : '' }}{{ row.financial.partial ? t('costCenter.text.attributionPending') : '' }}</small></template>
                    <template v-else><strong :class="procurementStrongClass(row.procurementAccruedBasis)">{{ row.isHistorical ? '—' : assetLedgerState === 'unavailable' ? t('costCenter.text.noData') : row.billingMode === 'metered' && row.profile.source !== 'custom' ? (cockpitAllTimeCostUsd(row.account.id) != null ? formatUsd(cockpitAllTimeCostUsd(row.account.id)!, 3) : t('costCenter.text.cumulativeUsage')) : formatCny(row.accrued, 3) }}<em v-if="row.procurementAccruedBasis === 'estimated'" class="cost-derived-tag">{{ t('costCenter.text.inferred') }}</em></strong><small>{{ row.isHistorical ? row.account.extra?.cliproxy_identity_source === 'usage_only' ? t('costCenter.text.usageRecordsRetainedNotProofOfCurrentManagement') : t('costCenter.text.historicalUsageRetainedExcludedFromCurrentPoolProcurement') : assetLedgerState === 'unavailable' ? sourceStates.accounts.reason : row.lossState?.active ? t('costCenter.text.finalWriteOffBanLoss', { value0: formatCny(row.impairmentCny, 3) }) : row.billingMode === 'metered' ? cockpitCumulativePartial(row.account.id) ? t('costCenter.text.knownPortionIncludesUnpricedUsageNotAComplete') : t('costCenter.text.apiUsageCostTopUpsAreNotTreated') : t('costCenter.text.costSettings', { value0: row.profile.billing_cycle }) }}</small></template>
                  </td>
                  <td><strong>{{ usageStatsFor(row)?.cost == null ? rowUsageMissingLabel(row) : formatUsd(usageStatsFor(row)?.cost, 4) }}</strong><small>{{ t('costCenter.text.standard2') }} {{ formatUsd(usageStatsFor(row)?.standard_cost, 4) }}{{ rowUsageSuffix(row) }}</small></td>
                  <td><strong :class="rowUserCost(row) != null ? 'cost-lime' : 'cost-unknown-value'">{{ rowUserCost(row) != null ? formatUsd(rowUserCost(row)!, 3) : rowUsageMissingLabel(row) }}</strong><small>{{ rowUserCost(row) != null ? `${costWindowCaption} · ${connectionType === null ? t('costCenter.text.calculatedCost') : connectionType === 'cliproxy' ? t('costCenter.text.estimatedCostNotUserBilling') : t('costCenter.text.userBilling')}${rowUsageSuffix(row)}` : rowUserCostNote(row) }}</small></td>
                  <td><strong>{{ usageStatsFor(row) ? formatInteger(usageStatsFor(row)?.requests) : rowUsageMissingLabel(row) }}</strong><small>{{ formatTokens(usageStatsFor(row)?.tokens) }} Token · {{ requestWindowCaption }}{{ rowUsageSuffix(row) }}</small></td>
                  <td v-if="connectionType === 'sub2api'"><UpstreamProbeCell :account-name="row.account.name" :state="probes[String(row.account.id)]" @probe="runProbe(row.account)" /></td>
                  <td v-else><strong v-if="cockpitAvgLatency(row.account.id) != null">{{ formatInteger(cockpitAvgLatency(row.account.id)) }} ms</strong><small v-if="cockpitAvgLatency(row.account.id) != null">{{ connectionType === 'cliproxy' ? t('costCenter.integration.cpaWindowLatency') : t('costCenter.text.recordedAverageLatency') }}</small><small v-else class="cost-muted">{{ t('costCenter.text.noLatencySamples') }}</small></td>
                  <td><small v-if="row.isHistorical">{{ t('costCenter.text.historicalRecordsDoNotEstablishCurrentErrorOr') }}</small><template v-else><strong>{{ row.currentState.error }} / {{ row.currentState.limited }}</strong><small :title="row.currentState.note">{{ row.currentState.note }}</small></template></td>
                  <td class="cost-group-cell"><span v-for="group in row.groups" :key="group" class="cost-tag">{{ group }}</span><span v-if="row.groups.length === 0" class="cost-tag">{{ t('costCenter.text.selfUse') }}</span></td>
                  <td class="cost-actions-cell">
                    <button v-if="probeCapable" type="button" :title="t('costCenter.text.testActualUpstreamConnectionTotalDuration')" :aria-label="t('costCenter.text.testActualUpstreamConnectionTotalDuration')" :class="{ 'is-loading': probes[String(row.account.id)]?.loading, 'is-success': probes[String(row.account.id)]?.success === true, 'is-error': probes[String(row.account.id)]?.success === false }" :disabled="probes[String(row.account.id)]?.loading" @click.stop="runProbe(row.account)">
                      <LoaderCircle v-if="probes[String(row.account.id)]?.loading" :size="15" class="cost-spin" />
                      <FlaskConical v-else :size="15" />
                      <span class="cost-action-tooltip" role="tooltip">{{ probes[String(row.account.id)]?.loading ? t('costCenter.text.contactingTheRealUpstream') : t('costCenter.text.testActualUpstreamConnectionDuration') }}</span>
                    </button>
                    <button type="button" :title="row.billingMode === 'metered' ? t('costCenter.text.viewMeteredApiCostRules') : t('costCenter.text.configureAccountProcurementCost')" :aria-label="row.billingMode === 'metered' ? t('costCenter.text.viewMeteredApiCostRules') : t('costCenter.text.configureAccountProcurementCost')" @click.stop="selectedAccount = row.account">
                      <Settings2 :size="15" />
                      <span class="cost-action-tooltip" role="tooltip">{{ row.billingMode === 'metered' ? (connectionType === null ? t('costCenter.text.calculatedUsingRecordedRequestUsageActualModelsAnd') : connectionType === 'cliproxy' ? t('costCenter.text.estimatedFromCpaUsageEventsActualModelsAnd') : t('costCenter.text.calculatedFromUsageActualUpstreamModelsPriceCatalog')) : t('costCenter.text.setPurchaseAmountPeriodAndCostStartTime') }}</span>
                    </button>
                  </td>
                </tr>
                <tr v-if="upstreamRows.length === 0"><td :colspan="upstreamColumnCount" class="cost-empty-row">{{ sourceStates.accounts.status === 'unavailable' ? t('costCenter.text.accountDataUnavailable', { value0: sourceStates.accounts.reason }) : t('costCenter.text.noMatchingUpstreamAccounts') }}</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <section v-else-if="activePanel === 'oauth'" class="cost-workspace cost-oauth" aria-labelledby="oauth-title">
          <header class="cost-oauth-heading">
            <h2 id="oauth-title">{{ t('costCenter.text.channelCosts') }}</h2>
            <p>{{ t('costCenter.text.updated') }} {{ lastUpdatedLabel }}</p>
          </header>

          <div class="cost-scope-notice">
            <strong>{{ t('costCenter.text.currentPoolBasis') }}</strong>
            <span>{{ t('costCenter.text.operatingAmountsUse') }} {{ rangeLabel }} {{ t('costCenter.text.matchedAccountsHistoricalRequestsAndEnteredFinancialRecords') }}</span>
            <small>{{ unassignedOperatingCount ? t('costCenter.text.historicalAccountsLackChannelTypeEvidence', { value0: unassignedOperatingCount, value1: poolPlatform === 'all' ? t('costCenter.text.includedInGlobalMissingInformationSubtotal') : t('costCenter.text.excludedFromThisChannel') }) : t('costCenter.text.requestsWithAccountIdsAreGroupedByProvable') }}{{ unattributedWindowRequests ? t('costCenter.text.requestsHaveNoAccountIdShownSeparatelyAnd', { value0: unattributedWindowRequests }) : '' }}{{ t('costCenter.text.currentPoolStarts') }}{{ currentPoolStartedAtLabel }}</small>
          </div>

          <div class="cost-pool-heading-row">
            <div class="cost-section-heading"><h2>{{ selectedPlatformLabel }} {{ t('costCenter.text.currentPool') }}</h2><p>{{ t('costCenter.text.cumulativeProcurementEstimateActiveAccounts') }} {{ oauthAccounts.length }} {{ t('costCenter.text.usingDefaultPlanCosts') }} {{ defaultCostAccountCount }} {{ t('costCenter.text.accountItems') }}</p></div>
            <div class="cost-platform-tabs" role="tablist" :aria-label="t('costCenter.text.channelCostPlatform')">
              <button v-for="item in accountPoolProviderTabs" :key="item.key" type="button" role="tab" :aria-selected="poolPlatform === item.key" :class="{ active: poolPlatform === item.key }" @click="poolPlatform = item.key">{{ item.label }}</button>
            </div>
            <button type="button" class="cost-primary-button cost-primary-button--outline" @click="reload()"><RefreshCcw :size="16" /> {{ t('costCenter.text.refreshPoolAccounting') }}</button>
          </div>

          <div class="cost-pool-summary">
            <MetricCell :label="t('costCenter.text.windowAccountsCurrentAccounts')" :value="`${poolOperatingSummary.accountCount} / ${oauthAccounts.length}`" :note="oauthActiveCount == null ? sourceStates.rangeStats.reason : t('costCenter.text.accountsWithRequests', { value0: rangeLabel, value1: oauthActiveCount, value2: participationAssignmentNote })" :state="sourceStates.rangeStats.status" />
            <MetricCell :label="t('costCenter.text.poolOperatingExpense', { value0: rangeLabel })" :value="formatAmount(poolOperatingSummary.expenseCny, 'CNY', 4)" :note="economicsQualityNote" :state="economicsDisplayState" />
            <MetricCell :label="t('costCenter.text.poolRecordedAccountLosses', { value0: rangeLabel })" :value="formatCny(oauthImpairmentCny, 4)" :note="recordedLossNote" :state="oauthImpairmentCny == null ? financePending ? 'loading' : 'unavailable' : financePending || financeError ? 'partial' : economicsDisplayState" accent="gold" />
            <MetricCell :label="t('costCenter.text.estimatedAccountExpenseUsd', { value0: rangeLabel })" :value="formatAmount(oauthWindowCostSummary, 'USD', 4)" :note="t('costCenter.text.sourcePricesAccountRateEstimates')" :title="t('costCenter.text.notProcurementPaymentEvidenceSubscriptionsDoNotAdd')" :state="sourceStates.rangeStats.status" />
            <MetricCell :label="connectionType === 'sub2api' ? t('costCenter.text.poolContributionProfitCny', { value0: rangeLabel }) : t('costCenter.text.poolApiReferenceValueUsd', { value0: rangeLabel })" :value="connectionType === 'sub2api' ? poolOperatingSummary.contributionCny == null ? t('costCenter.text.awaitingExpenseAttribution') : formatCny(poolOperatingSummary.contributionCny, 4) : formatAmount(oauthWindowOutputSummary, 'USD', 4)" :note="connectionType === 'sub2api' ? t('costCenter.text.sameGroupUserBillingOperatingExpenseCompleteProfit') : t('costCenter.text.sameWindowApiReferenceValueBeforeLocalMultiplier')" :state="economicsDisplayState" accent="blue" />
            <MetricCell :label="t('costCenter.text.poolOperatingStatus')" :value="hasMeasuredData(sourceStates.accounts) ? t('costCenter.text.schedulable', { value0: oauthNormalCount }) : t('costCenter.text.noData')" :note="t('costCenter.text.savedRequestsCurrentlyRateLimitedCurrentErrors', { value0: rangeLabel, value1: formatInteger(oauthRequests), value2: oauthLimitedCount, value3: oauthErrorCount, value4: connectionType === 'cliproxy' ? t('costCenter.text.currentlyDisabled', { value0: cliproxyHealthSummary.inactive }) : '', value5: probeNote })" :state="poolHealthState" />
            <MetricCell :label="connectionType === 'sub2api' ? t('costCenter.text.selectedPoolUserBillingAverageUsdH') : t('costCenter.text.selectedPoolApiReferenceValueAverageUsdH')" :value="formatKnownAmount(operatingRate(oauthWindowOutputSummary), 'USD', 6, true)" :note="amountCoverage(oauthWindowOutputSummary) + economicsSampleNote" :state="economicsDisplayState" accent="gold" />
            <MetricCell :label="t('costCenter.text.selectedPoolCombinedCostCnyH')" :value="formatKnownAmount(poolOperatingSummary.hourlyExpenseCny, 'CNY', 6, true)" :note="amountCoverage(poolOperatingSummary.hourlyExpenseCny) + t('costCenter.text.currentProcurementAccrualSameWindowMeteredRateAverage')" :state="economicsDisplayState" accent="gold" />
            <MetricCell :label="connectionType === 'sub2api' ? t('costCenter.text.poolUserBilling', { value0: rangeLabel }) : t('costCenter.text.poolApiReferenceValue', { value0: rangeLabel })" :value="formatKnownAmount(oauthWindowOutputSummary, 'USD', 4)" :note="amountCoverage(oauthWindowOutputSummary) + t('costCenter.text.selectedWindowAndMatchedAccountIdsIncludingEvidenced')" :state="sourceStates.rangeStats.status" />
            <MetricCell :label="connectionType === 'sub2api' ? t('costCenter.text.estimatedRemainingUserBillingTodayUsd') : t('costCenter.text.estimatedRemainingApiReferenceValueTodayUsd')" :value="formatOptionalUsd(oauthRemainingForecastUsd, 4, t('costCenter.text.insufficientAmountRecordedToday'))" :note="t('costCenter.text.projectsTodaySSavedRecordsForTheSame')" :state="hasMeasuredData(sourceStates.todayStats) ? 'estimated' : sourceStates.todayStats.status" />
            <MetricCell :label="t('costCenter.text.costPerUsdOfUsage')" :value="poolUnitCost.value" :note="poolUnitCost.note" :state="poolUnitCost.partial ? 'partial' : economicsDisplayState" />
            <MetricCell :label="t('costCenter.text.economicDataCompleteness')" :value="economicsQualityLabel" :note="economicsQualityNote" :state="economicsDisplayState" accent="lime" />
            <div class="cost-pool-output">
              <span>{{ rangeLabel }} · {{ connectionType === 'sub2api' ? t('costCenter.text.userBillingAmount') : t('costCenter.text.apiReferenceValue') }}</span><strong :class="poolValueClass(oauthWindowOutputSummary.total)">{{ formatAmount(oauthWindowOutputSummary, 'USD', 4) }}</strong>
              <div v-if="poolOutputProgress != null"><i :style="{ width: `${Math.min(100, poolOutputProgress)}%` }"></i></div>
              <small>{{ formatInteger(oauthRequests) }} {{ t('costCenter.text.requests3') }} {{ formatTokens(oauthTokens) }} Token</small>
            </div>
          </div>

          <div class="cost-chart-row">
            <ChartPanel :title="connectionType === null ? t('costCenter.text.globalCalculatedApiCostRate') : connectionType === 'cliproxy' ? t('costCenter.text.globalEstimatedApiCostRate') : t('costCenter.text.globalApiOutputRate')" :caption="apiRateChartCaption">
              <CostLineChart :labels="financialTrend.map(point => formatTrendLabel(point.timestamp))" :series="[{ label: connectionType === null ? t('costCenter.text.currentCalculatedCost') : connectionType === 'cliproxy' ? t('costCenter.text.currentEstimatedCost') : t('costCenter.text.currentOutput'), data: trendActualCost, color: '#e0bd4e', fill: true }, { label: rollingTrendLabel, data: rollingTrendActualCost, color: '#b9e55a', dashed: true }]" value-prefix="$" :state="trendFinancialState.status" :state-reason="trendFinancialReason" />
            </ChartPanel>
            <ChartPanel :title="t('costCenter.text.currentPoolProcurementRate')" :caption="t('costCenter.text.existingAccountsDeterministicConversionNotHistoricalMeasurement', { value0: selectedPlatformLabel })">
              <CostLineChart :labels="financialTrend.map(point => formatTrendLabel(point.timestamp))" :series="[{ label: t('costCenter.text.currentPoolProcurementRate2'), data: oauthProcurementBaseline, color: '#7eb6d8', dashed: true }]" value-prefix="¥" :state="assetLedgerState === 'measured' ? 'estimated' : assetLedgerState" :state-reason="sourceStates.costLoss.reason" />
            </ChartPanel>
          </div>

          <div class="cost-pool-table-wrap">
            <table class="cost-pool-table">
              <thead><tr><th>{{ t('costCenter.text.accountingScope') }}</th><th>{{ t('costCenter.text.accountType') }}</th><th>{{ t('costCenter.text.windowAccountCount') }}</th><th>{{ t('costCenter.text.requestsWithinWindow') }}</th><th>{{ t('costCenter.text.currentStatusDistribution') }}</th><th>{{ t('costCenter.text.windowOperatingExpense') }}</th><th>{{ t('costCenter.text.averageWindowExpense') }}</th><th>{{ t('costCenter.text.windowAmountDailyProjectionMonthlyProjection') }}</th><th>{{ t('costCenter.text.combinedHourlyExpenseSourceRateValue') }}</th><th>{{ t('costCenter.text.windowRequests') }}</th><th>{{ t('costCenter.text.windowTokens') }}</th></tr></thead>
              <tbody>
                <tr v-for="group in poolGroups" :key="group.plan">
                  <td><strong>{{ connectionType === 'cliproxy' ? t('costCenter.text.localCpaPlugin') : t('costCenter.text.currentPool2') }}</strong></td><td><strong>{{ group.planLabel }}</strong></td><td>{{ group.count }}</td><td>{{ group.productive }}</td>
                  <td><small v-if="group.isUnattributed">{{ t('costCenter.text.unattributedRequestsAccountStatusesNotAggregated') }}</small><template v-else><div class="cost-status-ring" :style="{ background: group.statusRing }"><span></span></div><small>{{ t('costCenter.text.normal') }} {{ group.normal }} {{ t('costCenter.text.rateLimited') }} {{ group.limited }} {{ t('costCenter.text.errors') }} {{ group.errors }} {{ t('costCenter.text.windowHeadroom') }} {{ formatPercentOrDash(group.quotaRemaining) }}</small></template></td>
                  <td><strong>{{ formatAmount(group.expenseSummary, 'CNY', 4) }}</strong><small>{{ rangeLabel }} {{ t('costCenter.text.sameGroupProcurementMeteredCredits') }}</small></td>
                  <td><strong>{{ group.count ? formatAmount(group.averageExpenseSummary, 'CNY', 4) : t('costCenter.text.notApplicable') }}</strong><small>{{ group.count ? t('costCenter.text.sameGroupWindowExpenseWindowAccounts') : t('costCenter.text.noPerAccountAverageForRequestsLackingAccount') }}</small></td>
                  <td><strong :class="poolValueClass(group.outputSummary.total)">{{ formatAmount(group.outputSummary, 'USD', 4) }} / {{ formatUsd(group.dayForecastUsd, 4) }} / {{ formatUsd(group.monthForecastUsd, 4) }}</strong><small>{{ rangeLabel }} {{ connectionType === 'sub2api' ? t('costCenter.text.userBillingAmount') : t('costCenter.text.apiReferenceValue') }} {{ t('costCenter.text.todaySUsageProjectedToFullDayToday') }}</small></td>
                  <td><strong>{{ formatAmount(group.hourlySummary, 'CNY', 6, true) }} / {{ formatAmount(group.sourceCostSummary, 'USD', 4) }}</strong><small>{{ t('costCenter.text.cnyHCombinedExpenseUsdEstimatedAccountExpense') }}</small></td>
                  <td>{{ formatInteger(group.requests) }}</td><td>{{ formatTokens(group.tokens) }}</td>
                </tr>
                <tr v-if="poolGroups.length === 0"><td colspan="11" class="cost-empty-row">{{ sourceStates.accounts.status === 'unavailable' ? t('costCenter.text.accountDataUnavailable', { value0: sourceStates.accounts.reason }) : t('costCenter.text.noAccountsInTheCurrentChannel') }}</td></tr>
              </tbody>
            </table>
          </div>
        </section>

        <DataGovernancePanel
          v-else-if="activePanel === 'governance'"
          class="cost-workspace"
          :source-kind="costSourceKind"
          :states="sourceStates"
          :economics="accountEconomics"
          :last-updated="lastUpdatedLabel"
          :loading="loading"
          @refresh="reload"
        />

        <!-- ==================== 三端汇总 workspace ==================== -->
        <section v-else-if="activePanel === 'finance'" class="cost-workspace" aria-labelledby="finance-title">
          <div class="cost-page-heading">
            <div><span>{{ t('costCenter.text.localCostLedger') }}</span><h2 id="finance-title">{{ t('costCenter.text.purchasesRenewalsAdjustments') }}</h2></div>
            <p>{{ rangeLabel }} · {{ brandEyebrow }} {{ t('costCenter.text.originalCurrenciesAccountedSeparately') }}</p>
          </div>
          <CostEventsPanel :source="costSourceKind" :instance-id="financeInstanceId" :start-ms="financeWindow.start.getTime()" :end-ms="financeWindow.end.getTime()" :accounts="financeAccounts" @changed="loadLocalFinance" />
        </section>

        <section v-else-if="activePanel === 'unified'" class="cost-workspace cost-unified" aria-labelledby="unified-title">
          <div class="cost-section-heading">
            <span>{{ t('costCenter.text.unifiedSummary') }}</span>
            <h2 id="unified-title">{{ t('costCenter.text.unifiedCostSummary') }}</h2>
            <p>{{ rangeLabel }} {{ t('costCenter.text.selected2') }} {{ unified.selectedCount.value }} {{ t('costCenter.text.sourcesWindowResultsFrom') }} {{ unified.contributedSources.value.length }} {{ t('costCenter.text.sourcesSourceSubtotalsAddedWithoutCrossSourceRequest') }}</p>
          </div>

          <!-- 汇总配置条:勾选要汇入的端 -->
          <div class="cost-unified-sources">
            <label v-for="key in (['sub2api','cliproxy','cockpit'] as const)" :key="key" class="cost-source-toggle" :class="{ active: unified.selectedSources.value.has(key) }">
              <input type="checkbox" :checked="unified.selectedSources.value.has(key)" @change="unified.toggleSource(key)" />
              <span class="cost-source-dot" :class="`source-${key}`"></span>
              <span class="cost-source-name">{{ key }}</span>
              <span class="cost-source-state" :class="`state-${unified.sourceStatuses.value[key].state}`">{{ unified.sourceStatuses.value[key].reason }}</span>
            </label>
          </div>

          <!-- 总成本大数 -->
          <div class="cost-unified-total">
            <div class="cost-donut-wrap">
              <div class="cost-donut cost-donut--unified">
                <div>
                  <!-- ★ 外观也必须跟着可信度走(2026-09-23):`cost-lime` 是**实测**强调色。
                       含下界分项的总额只是下界,却和完全实测的总额长得一模一样
                       —— 与"推算值不得与实测值同外观"是同一条红线(分项格走 TruthfulMetric,
                       partial 会掉 accent;唯独这个大数绕过了那道门控)。 -->
                  <strong :class="unified.totalCostUsd.value == null ? 'cost-unknown-value' : (unified.lowerBoundSources.value.length ? 'cost-estimated' : 'cost-lime')">{{ unified.totalCostUsd.value == null ? '—' : formatUsd(unified.totalCostUsd.value, 2) }}</strong>
                  <span>{{ t('costCenter.text.sourceSubtotalSumUsd') }}</span>
                  <small v-if="unified.totalCostUnitMixed.value" class="cost-muted">{{ t('costCenter.text.selectedSourceBasesDifferCumulativeWindowCannotAdd') }}</small>
                  <small v-else-if="unified.totalCostNote.value" class="cost-muted">{{ unified.totalCostNote.value }}</small>
                </div>
              </div>
            </div>
            <div class="cost-metric-grid">
              <MetricCell :label="t('costCenter.text.sub2apiAccountCost')" :value="formatUsd(unified.sub2apiCost.value, 2)" :note="unifiedCostNote(unified.sourceStatuses.value.sub2api, unified.sub2apiCostUnit.value)" :state="unified.sourceStatuses.value.sub2api.state" accent="gold" />
              <MetricCell :label="t('costCenter.text.cockpitCost')" :value="formatUsd(unified.cockpitCost.value, 2)" :note="unifiedCostNote(unified.sourceStatuses.value.cockpit, unified.cockpitCostUnit.value)" :state="unified.sourceStatuses.value.cockpit.state" accent="lime" />
              <MetricCell :label="t('costCenter.text.cliproxyEstimatedCost')" :value="unified.cliproxyCostBasis.value.kind === 'no_price_no_estimate' ? t('costCenter.text.costUnknown') : formatUsd(unified.cliproxyCost.value, 2)" :note="cliproxyCostNote" :state="unified.sourceStatuses.value.cliproxy.state" accent="blue" />
              <MetricCell :label="t('costCenter.text.cockpitWindowTokens')" :value="unified.sourceReadings.value.cockpit?.tokens == null ? t('costCenter.text.unavailable') : formatTokens(unified.sourceReadings.value.cockpit.tokens)" :note="t('costCenter.text.localUsageRecordsInTheSameTimeRange')" :state="unified.sourceStatuses.value.cockpit.state" />
              <MetricCell :label="t('costCenter.text.cockpitWindowRequests')" :value="unified.sourceReadings.value.cockpit?.records == null ? t('costCenter.text.unavailable') : formatInteger(unified.sourceReadings.value.cockpit.records)" :note="t('costCenter.text.localRequestRecordsInTheSameTimeRange')" :state="unified.sourceStatuses.value.cockpit.state" />
              <MetricCell :label="t('costCenter.text.cliproxyMatchedRequests')" :value="formatInteger(unified.cliproxyEstimate.value?.matchedRequests)" :note="unified.cliproxyEstimate.value ? t('costCenter.text.unmatchedRecords', { value0: unified.cliproxyEstimate.value.unmatchedRequests, value1: cliproxyEstimateBasisSuffix }) : t('costCenter.text.noData')" :state="unified.cliproxyEstimate.value ? 'estimated' : 'unavailable'" />
            </div>
          </div>

          <!-- 口径提示条 -->
          <div class="cost-provenance-strip">
            <div><CircleCheck :size="15" /><strong>Sub2API</strong><span>{{ t('costCenter.text.usesAccountCostSnapshotsInRecordsNotUser') }}</span></div>
            <div class="is-warning"><TriangleAlert :size="15" /><strong>{{ t('costCenter.text.localEstimate') }}</strong><span>{{ t('costCenter.text.cockpitAndCliproxyUseLocalUsageAndAvailable') }}</span></div>
            <div><TrendingUp :size="15" /><strong>{{ t('costCenter.text.sharedTimeWindow') }}</strong><span>{{ t('costCenter.text.allThreeSourcesUseTheSameStartEnd') }}</span></div>
          </div>

          <!-- cockpit token 结构 -->
          <div class="cost-table-wrap">
            <div class="cost-section-heading"><h3>{{ t('costCenter.text.currentWindowRecords') }}</h3><p>{{ t('costCenter.text.sourcesAccountedIndependentlyAForwardingChainMayAppear') }}</p></div>
            <table class="cost-data-table cost-window-table"><thead><tr><th>{{ t('costCenter.text.source2') }}</th><th>{{ t('costCenter.text.requests') }}</th><th>Token</th><th>{{ t('costCenter.text.amountUsd') }}</th><th>{{ t('costCenter.text.timeWindow') }}</th><th>{{ t('costCenter.text.measurementBasis') }}</th></tr></thead><tbody>
              <tr v-for="key in (['sub2api', 'cliproxy', 'cockpit'] as const)" :key="key">
                <td>{{ { sub2api: 'Sub2API', cliproxy: 'CLIProxy', cockpit: 'Cockpit' }[key] }}</td>
                <td>{{ unified.sourceReadings.value[key]?.records == null ? t('costCenter.text.unavailable') : formatInteger(unified.sourceReadings.value[key]!.records) }}</td>
                <td>{{ unified.sourceReadings.value[key]?.tokens == null ? t('costCenter.text.unavailable') : formatTokens(unified.sourceReadings.value[key]!.tokens) }}</td>
                <td>{{ formatUsd(unified.sourceReadings.value[key]?.costUsd, 5) }}</td>
                <td>{{ unified.sourceReadings.value[key] ? `${formatCompactDate(unified.sourceReadings.value[key]!.startMs)} - ${formatCompactDate(unified.sourceReadings.value[key]!.endMs)}` : t('costCenter.text.notLoaded') }}</td>
                <td>{{ unified.sourceStatuses.value[key].reason }}</td>
              </tr>
            </tbody></table>
          </div>
          <details v-if="unified.cockpitStats.value" class="cost-historical-details">
            <summary>{{ t('costCenter.text.cockpitCumulativeArchiveExcludedFromCurrentWindowTotal') }}</summary>
          <div class="cost-metric-grid cost-metric-grid--tokens">
            <MetricCell label="Input Tokens" :value="formatTokens(unified.cockpitStats.value.totals.inputTokens)" :state="finiteOrNull(unified.cockpitStats.value.totals.inputTokens) == null ? 'unavailable' : 'measured'" />
            <MetricCell label="Output Tokens" :value="formatTokens(unified.cockpitStats.value.totals.outputTokens)" :state="finiteOrNull(unified.cockpitStats.value.totals.outputTokens) == null ? 'unavailable' : 'measured'" />
            <MetricCell label="Cached Tokens" :value="formatTokens(unified.cockpitStats.value.totals.cachedTokens)" :state="finiteOrNull(unified.cockpitStats.value.totals.cachedTokens) == null ? 'unavailable' : 'measured'" />
            <MetricCell label="Reasoning Tokens" :value="formatTokens(unified.cockpitStats.value.totals.reasoningTokens)" :state="finiteOrNull(unified.cockpitStats.value.totals.reasoningTokens) == null ? 'unavailable' : 'measured'" />
          </div>

          <!-- cockpit codex 账号明细表 -->
          <div v-if="unified.cockpitAccountRows.value.length > 0" class="cost-table-wrap">
            <div class="cost-section-heading">
              <span>{{ t('costCenter.text.codexAccountDetails') }}</span>
              <h2>{{ t('costCenter.text.cockpitCodexAccounts') }}</h2>
              <p>{{ t('costCenter.text.costDescendingPlanSubscriptionInformationMergedFromCodex') }}</p>
            </div>
            <div class="cost-table-scroll">
              <table class="cost-table">
                <thead>
                  <tr>
                    <th>{{ t('costCenter.text.email') }}</th><th>Plan</th><th>{{ t('costCenter.text.subscriptionExpires') }}</th>
                    <th class="num">{{ t('costCenter.text.requests') }}</th><th class="num">Input</th><th class="num">Output</th><th class="num">{{ t('costCenter.text.costUsd') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="a in unified.cockpitAccountRows.value" :key="a.accountId">
                    <td><strong>{{ a.email || a.accountId }}</strong><small>{{ a.accountId }}</small></td>
                    <td><span class="cost-badge" :class="planBadgeClass(a.planType)">{{ a.planType || '—' }}</span></td>
                    <td><small>{{ a.subscriptionUntil || '—' }}</small></td>
                    <td class="num">{{ formatInteger(a.usage.requestCount) }}</td>
                    <td class="num">{{ formatTokens(a.usage.inputTokens) }}</td>
                    <td class="num">{{ formatTokens(a.usage.outputTokens) }}</td>
                    <td class="num" :class="a.costBasis === 'no_price_no_estimate' ? 'cost-unknown-value' : 'cost-emphasis'"><template v-if="a.costBasis === 'no_price_no_estimate'">{{ t('costCenter.text.costUnknown') }}<small class="cost-muted">{{ t('costCenter.text.noUnitPriceOrSourceEstimate') }}</small></template><template v-else>{{ formatUsd(a.costUsd, 2) }}<small v-if="a.costLowerBound" class="cost-muted">{{ t('costCenter.text.includesUnpricedModelsValueIsALowerBound') }}</small><small v-else-if="!a.costIsOurs" class="cost-muted">{{ t('costCenter.text.sourceEstimate') }}</small></template></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <!-- cliproxy 按模型反算明细 -->
          </details>
          <div v-if="unified.cliproxyEstimate.value && unified.cliproxyEstimate.value.byModel.length > 0" class="cost-table-wrap">
            <div class="cost-section-heading">
              <span>{{ t('costCenter.text.cliproxyModelEstimates') }}</span>
              <h2>{{ t('costCenter.text.cliproxyEstimatesByModel') }}</h2>
              <p>{{ t('costCenter.text.cpaUsageEventsTokensModelPricesPerToken') }}{{ unified.cliproxyEstimate.value.totalCostLabel ? ` · ${unified.cliproxyEstimate.value.totalCostLabel}` : '' }}</p>
            </div>
            <div class="cost-table-scroll">
              <table class="cost-table">
                <thead>
                  <tr>
                    <th>{{ t('costCenter.text.model') }}</th><th class="num">{{ t('costCenter.text.requests4') }}</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cached</th><th class="num">{{ t('costCenter.text.estimatedCostUsd') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="m in unified.cliproxyEstimate.value.byModel" :key="m.model">
                    <td><strong>{{ m.model }}</strong></td>
                    <td class="num">{{ formatInteger(m.requestCount) }}</td>
                    <td class="num">{{ formatTokens(m.inputTokens) }}</td>
                    <td class="num">{{ formatTokens(m.outputTokens) }}</td>
                    <td class="num">{{ formatTokens(m.cachedTokens) }}</td>
                    <td class="num" :class="m.costUnknown ? 'cost-unknown-value' : 'cost-emphasis'">{{ m.costUnknown ? t('costCenter.text.costUnknown') : formatUsd(m.costUsd, 4) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="unified.error.value" class="cost-error" role="alert">
            <TriangleAlert :size="17" /><span>{{ unified.error.value }}</span>
          </div>
        </section>

        <!-- ==================== cliproxy API 接入中心 ==================== -->
        <section v-else-if="connectionType === 'cliproxy' && activePanel === 'api'" class="cost-workspace cost-api-workspace" aria-labelledby="cliproxy-api-title">
          <div class="cost-section-heading">
            <h2 id="cliproxy-api-title">{{ t('costCenter.text.apiAccessCenter') }}</h2>
            <p>{{ t('costCenter.text.openaiCompatibleEndpointsV1XApiKeyOr') }}</p>
          </div>
          <div class="cost-metric-grid">
            <MetricCell :label="t('costCenter.text.apiEndpoint')" :value="cliproxyBusinessBase || UNKNOWN_DASH" :note="t('costCenter.text.openaiCompatibleV1')" :state="truthfulState(cliproxyBusinessBase)" accent="lime" />
            <!-- state 不能写 measured:value 是硬编码字符串,没测任何东西。
                 取 estimated —— 与同文件 `assetLedgerState === 'measured' ? 'estimated'` 同一约定:
                 「来自本项目自有知识/配置,不是从数据源读出来的实测值」。
                 不用 partial:它的文案是「部分可用」,会让人以为某数据源只交付了一部分。 -->
            <MetricCell :label="t('costCenter.text.authentication')" value="X-API-Key / Bearer" :note="t('costCenter.text.apiKeyForV1Authentication')" state="estimated" />
            <MetricCell :label="t('costCenter.text.version')" :value="cliproxyOverview?.version || '—'" :note="t('costCenter.text.cpaDoesNotExposeAVersionInterface')" :state="cliproxyOverview?.version ? 'measured' : 'unavailable'" />
            <MetricCell :label="t('costCenter.text.authFiles')" :value="formatInteger(cliproxyOverview?.authFileCount)" note="auth-files" :state="truthfulState(cliproxyOverview?.authFileCount)" />
            <MetricCell :label="t('costCenter.text.routingStrategy')" :value="cliproxyOverview?.routingStrategy || '—'" note="routing-strategy" :state="cliproxyOverview?.routingStrategy ? 'measured' : 'unavailable'" />
            <MetricCell :label="t('costCenter.text.debugMode')" :value="cliproxyOverview?.debug === true ? t('costCenter.text.on') : cliproxyOverview?.debug === false ? t('costCenter.text.close') : '—'" note="debug" :state="cliproxyOverview?.debug == null ? 'unavailable' : 'measured'" />
          </div>
          <!-- 推理档位分布(CPA usage_events.reasoning_effort)。
               cockpit 侧早有「推理档位」chip,cliproxy 侧此前零消费 —— 这条补上后三源对称。
               空串 = 上游未记录档位:单列一行,既不并入任何真实档位,也不显示成 0。 -->
          <div class="cost-facet-chips cost-cliproxy-reasoning">
            <div v-if="data.cliproxyReasoningEfforts.value === null" class="cost-facet-chip is-muted">
              <span>{{ t('costCenter.text.reasoningEffort') }}</span>
              <strong>{{ t('costCenter.text.unavailable2') }}</strong>
              <small>{{ t('costCenter.text.noCpaUsageEventsLoaded') }}</small>
            </div>
            <div v-else-if="data.cliproxyReasoningEfforts.value.length === 0" class="cost-facet-chip is-muted">
              <span>{{ t('costCenter.text.reasoningEffort') }}</span>
              <strong>{{ t('costCenter.text.noData') }}</strong>
              <small>{{ t('costCenter.text.noCpaRequestsInTheSelectedPeriod') }}</small>
            </div>
            <template v-else>
              <div v-if="cliproxyReasoningEffortTiers.length === 0" class="cost-facet-chip is-muted">
                <span>{{ t('costCenter.text.reasoningEffort') }}</span>
                <strong>{{ t('costCenter.text.effortNotRecorded') }}</strong>
                <small>{{ t('costCenter.text.noReasoningEffortRecordedForRequestsInThe') }}</small>
              </div>
              <div v-else class="cost-facet-chip">
                <span>{{ t('costCenter.text.reasoningEffort') }}</span>
                <strong>{{ cliproxyReasoningEffortTiers.map((r) => `${r.label} ${formatInteger(r.count)}`).join(' · ') }}</strong>
                <small>{{ t('costCenter.text.cpaUsageEventsReasoningEffortUnrecognizedValuesShown') }}</small>
              </div>
              <div v-if="cliproxyReasoningEffortUnrecorded" class="cost-facet-chip">
                <span>{{ t('costCenter.text.unrecordedTier') }}</span>
                <strong>{{ formatInteger(cliproxyReasoningEffortUnrecorded.count) }} {{ t('costCenter.text.requests2') }}</strong>
                <small>{{ t('costCenter.text.upstreamDidNotRecordReasoningEffortExcludedFrom') }}</small>
              </div>
            </template>
          </div>
          <div class="cost-table-wrap">
            <div class="cost-section-heading"><span>{{ t('costCenter.text.apiEndpoint') }}</span><h2>{{ t('costCenter.text.apiEndpointAccess') }}</h2><p>{{ t('costCenter.text.clientsUseTheApiKeyForV1Management') }}</p></div>
            <div class="cost-table-scroll">
              <table class="cost-table">
                <thead><tr><th>{{ t('costCenter.text.endpoint') }}</th><th>{{ t('costCenter.text.method') }}</th><th>{{ t('costCenter.text.authentication2') }}</th><th>{{ t('costCenter.text.description') }}</th></tr></thead>
                <tbody>
                  <tr><td><code>{{ cliproxyEndpoint('/v1/models') }}</code></td><td>GET</td><td>X-API-Key</td><td>{{ t('costCenter.text.listAvailableModels') }}</td></tr>
                  <tr><td><code>{{ cliproxyEndpoint('/v1/chat/completions') }}</code></td><td>POST</td><td>Bearer</td><td>{{ t('costCenter.text.chatCompletionsOpenaiCompatible') }}</td></tr>
                  <tr><td><code>{{ cliproxyEndpoint('/v1/responses') }}</code></td><td>POST</td><td>Bearer</td><td>Responses API</td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="cost-model-note">
            {{ t('costCenter.text.managementApiV0ManagementRequiresSecretKeyBearer') }}
          </div>
        </section>

        <!-- ==================== cliproxy 管理面板 iframe ==================== -->
        <section v-else-if="activePanel === 'cliproxy-manage'" class="cost-workspace cost-cliproxy-manage">
          <p v-if="cliproxyManageUsesDefaultPort" class="cost-model-note cost-model-note--warning">
            {{ t('costCenter.text.noManagementAddressConfiguredCpaDefaultPort8317') }}
          </p>
          <iframe ref="cliproxyManageFrame" :src="cliproxyManageUrl" class="cost-iframe" frameborder="0" allowfullscreen @load="injectCliproxyManagementKey"></iframe>
        </section>

        <section v-else-if="connectionType === null && activePanel === 'api'" class="cost-workspace cost-api-workspace" aria-labelledby="cockpit-api-title">
          <div class="cost-section-heading">
            <span>{{ t('costCenter.text.localGateway') }}</span>
            <h2 id="cockpit-api-title">{{ t('costCenter.text.cockpitLocalGatewayAccess') }}</h2>
            <p>{{ t('costCenter.text.codexLocalAccessJsonLocalSidecarApikeyApi') }}</p>
          </div>
          <div v-if="loading && !cockpitLocalAccess" class="cost-empty"><LoaderCircle :size="20" class="cost-spin" /><span>{{ t('costCenter.text.loading') }}</span></div>
          <div v-else-if="!cockpitLocalAccess" class="cost-empty"><span>{{ t('costCenter.text.noCockpitLocalAccessConfigurationRunCockpitTools') }}</span></div>
          <template v-else>
            <div class="cost-metric-grid">
              <MetricCell :label="t('costCenter.text.gatewayUrl')" :value="cockpitGatewayUrl" :note="t('costCenter.text.localSidecarLocalAccessOnly')" :state="truthfulState(cockpitGatewayUrl)" accent="lime" />
              <!-- 审查 #9:值没拿到就挂"实测"徽标 = 把"没读到"说成"已测"。状态跟着值走。 -->
              <MetricCell :label="t('costCenter.text.accessScope')" :value="cockpitLocalAccess.accessScope || UNKNOWN_DASH" note="accessScope" :state="truthfulState(cockpitLocalAccess.accessScope)" />
              <MetricCell :label="t('costCenter.text.routingStrategy')" :value="cockpitLocalAccess.routingStrategy || UNKNOWN_DASH" note="routingStrategy" :state="truthfulState(cockpitLocalAccess.routingStrategy)" />
              <MetricCell :label="t('costCenter.text.gatewayMode')" :value="cockpitLocalAccess.gatewayMode || UNKNOWN_DASH" note="gatewayMode" :state="truthfulState(cockpitLocalAccess.gatewayMode)" />
              <MetricCell :label="t('costCenter.text.primaryApiKey')" :value="maskCockpitKey(cockpitLocalAccess.apiKey)" :note="t('costCenter.text.apikeyMasked')" :state="truthfulState(cockpitLocalAccess.apiKey)" accent="gold" />
              <MetricCell :label="t('costCenter.text.enabledApiKeys')" :value="formatInteger(cockpitLocalAccess.apiKeys?.filter(k => k.enabled).length)" :note="t('costCenter.text.total', { value0: formatInteger(cockpitLocalAccess.apiKeys?.length) })" :state="truthfulState(cockpitLocalAccess.apiKeys)" />
            </div>

            <!-- 本地持久账本(二期 T11–T13)。此前 ledger_ingest 全仓零调用、账本从未落盘;
                 这里**逐源**如实展示摄取结果,让"账本真的在跑"可被用户看见,
                 也让"某个源一行都没进来"无处藏身(而不是合并成一个数字蒙过去)。 -->
            <div class="cost-import-result" :class="ledgerIngestDelivered ? 'is-success' : ''" style="margin-bottom: 12px;">
              <strong>{{ t('costCenter.text.persistentLocalLedger') }}</strong> · {{ ledgerIngestLabel }}
              <small style="display:block; opacity:.72; margin-top:2px;">{{ t('costCenter.text.costLedgerSqliteStoresUsageNotMonetaryCalculations') }}</small>
            </div>

            <!-- P0-25 多源对账。本面板**只出证据、不合并** —— 对账结果不参与任何总额。
                 合并口径 P0-15 已定案为「按天(UTC) × 模型取大」,由下方面板呈现。
                 证据必须可复核:结论 + 逐天结构 + 偏离天 + 阈值全部摆出来。 -->
            <div class="cost-table-wrap">
              <div class="cost-section-heading">
                <span>{{ t('costCenter.text.multiSourceReconciliationP025') }}</span>
                <h2>{{ t('costCenter.text.twoSourcesSideBySideEvidenceOnlyTotals') }}</h2>
                <p>{{ t('costCenter.text.ledgerReaderFullWindowProducesNoTotalsThis') }}</p>
              </div>
              <div v-if="!reconcileLoaded" class="cost-empty"><LoaderCircle :size="18" class="cost-spin" /><span>{{ t('costCenter.text.loadingMultiSourceReconciliation') }}</span></div>
              <div v-else-if="!reconcile || !reconcile.available" class="cost-empty"><span>{{ t('costCenter.text.multiSourceReconciliationUnavailable') }}{{ reconcile?.reason ?? t('costCenter.text.ledgerNotGenerated') }}</span></div>
              <template v-else>
                <div class="cost-import-result" :class="reconcileTone === 'ok' ? 'is-success' : ''" style="margin-bottom:10px;">
                  <strong>{{ t('costCenter.text.mergePolicyDailyModelMaximum') }}</strong> · {{ reconcileVerdictLabel }}
                  <small style="display:block; opacity:.78; margin-top:3px;">{{ reconcile.verdictReason }}</small>
                  <small v-if="reconcile.t0Ms" style="display:block; opacity:.62; margin-top:2px;">{{ t('costCenter.text.basisAStartEarliestLogs') }} {{ formatUtcDay(reconcile.t0Ms) }} {{ t('costCenter.text.differenceThreshold') }} {{ (reconcile.divergenceThreshold * 100).toFixed(0) }}%</small>
                </div>

                <!-- 逐源合计:两源各自成行,永不合并 -->
                <div class="cost-table-scroll">
                  <table class="cost-table">
                    <thead><tr><th>{{ t('costCenter.text.sources') }}</th><th class="num">Token</th><th class="num">{{ t('costCenter.text.requests') }}</th><th class="num">{{ t('costCenter.text.daysCovered') }}</th><th>{{ t('costCenter.text.coverageInterval') }}</th><th class="num">{{ t('costCenter.text.ledgerRows') }}</th><th class="num">{{ t('costCenter.text.watermark') }}</th></tr></thead>
                    <tbody>
                      <tr v-for="s in reconcile.sources" :key="s.sourceName">
                        <td><strong>{{ s.label }}</strong><small>{{ s.sourceName }}</small></td>
                        <td class="num">{{ formatTokens(s.tokens) }}</td>
                        <td class="num">{{ formatInteger(s.requests) }}</td>
                        <td class="num">{{ s.days }}</td>
                        <td><small>{{ s.firstMs ? formatUtcDay(s.firstMs) : '—' }} → {{ s.lastMs ? formatUtcDay(s.lastMs) : '—' }}</small></td>
                        <td class="num">{{ formatInteger(ledgerSources.find((x) => x.sourceName === s.sourceName)?.rows ?? null) }}</td>
                        <td class="num"><small>{{ ledgerSources.find((x) => x.sourceName === s.sourceName)?.lastId ?? '—' }}</small></td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- 偏离天:用户拍板的关键证据(整体差异比会被它们拉高) -->
                <div v-if="reconcile.topDivergentDays.length" class="cost-table-scroll" style="margin-top:12px;">
                  <div class="cost-section-heading"><span>{{ t('costCenter.text.divergentDays') }}</span><h2>{{ t('costCenter.text.largestDifferencesOnOverlappingDays') }}</h2><p>{{ t('costCenter.text.aFewAnomalousDaysCanInflateTheTotal') }}</p></div>
                  <table class="cost-table">
                    <thead><tr><th>{{ t('costCenter.text.dateUtc') }}</th><th class="num">logs</th><th class="num">sessions</th><th class="num">{{ t('costCenter.text.difference') }}</th><th class="num">{{ t('costCenter.text.divergenceRatio') }}</th></tr></thead>
                    <tbody>
                      <tr v-for="d in reconcile.topDivergentDays" :key="d.day">
                        <td><strong>{{ d.day }}</strong></td>
                        <td class="num">{{ formatTokens(d.logsTokens) }}</td>
                        <td class="num">{{ formatTokens(d.sessionsTokens) }}</td>
                        <td class="num">{{ d.tokenDiff > 0 ? '+' : '' }}{{ formatTokens(d.tokenDiff) }}</td>
                        <td class="num">{{ formatDivergence(d.divergence) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <!-- (天, 模型) 并列明细:默认只列真正的重叠格(两源都有量) -->
                <div class="cost-table-scroll" style="margin-top:12px;">
                  <div class="cost-section-heading">
                    <span>{{ t('costCenter.text.overlapDetails') }}</span>
                    <h2>{{ t('costCenter.text.tokensFromBothSourcesByDayModel') }}</h2>
                    <p>{{ t('costCenter.text.onlyCellsWithUsageInBothSources') }}{{ reconcileOverlapRows.length }} {{ t('costCenter.text.cellsDifferenceSessionsLogs') }}</p>
                  </div>
                  <table class="cost-table">
                    <thead><tr><th>{{ t('costCenter.text.dateUtc') }}</th><th>{{ t('costCenter.text.model') }}</th><th class="num">logs</th><th class="num">sessions</th><th class="num">{{ t('costCenter.text.difference') }}</th><th class="num">{{ t('costCenter.text.divergenceRatio') }}</th></tr></thead>
                    <tbody>
                      <tr v-for="c in reconcileOverlapRows" :key="`${c.dayBucketMs}-${c.modelId}`">
                        <td><small>{{ c.day }}</small></td>
                        <td><strong>{{ c.modelId || t('costCenter.text.emptyModel') }}</strong></td>
                        <td class="num">{{ formatTokens(c.logsTokens) }}</td>
                        <td class="num">{{ formatTokens(c.sessionsTokens) }}</td>
                        <td class="num">{{ c.tokenDiff > 0 ? '+' : '' }}{{ formatTokens(c.tokenDiff) }}</td>
                        <td class="num">{{ formatDivergence(c.divergence) }}</td>
                      </tr>
                      <tr v-if="reconcileOverlapRows.length === 0"><td colspan="6" class="cost-empty-row">{{ t('costCenter.text.noOverlappingDayModelCellsBetweenTheTwo') }}</td></tr>
                    </tbody>
                  </table>
                </div>
                <small class="cost-muted" style="display:block; margin-top:6px;">{{ t('costCenter.text.reconciliationProvidesEvidenceOnlyAndDoesNotAffect') }}</small>
              </template>
            </div>

            <!-- P0-15 合并口径用量(已拍板:按「天(UTC) × 模型」取大,不相加)。
                 每格都带 winner / 两源原始 token,可自证"数从哪来、是不是会话源补的"。
                 ⚠️ 档位**与来源无关**:两源都走 TokenSplit::add(阈值 272_000)判档,
                    sessions 格的 long 档照常按 ×2/×2/×1.5 计价 —— 表里"长文本档"列是**实测值**,
                    不是"有没有分档"的标记(2026-09-12 修正:初版按来源标"未分档"是错的)。
                 ⚠️ 本面板**不参与资产总览总额** —— 总额仍走 cockpit 直连口径(避免数字突变作废 §三 基线)。 -->
            <div class="cost-table-wrap">
              <div class="cost-section-heading">
                <span>{{ t('costCenter.text.mergedUsageP015') }}</span>
                <h2>{{ t('costCenter.text.dailyModelMaximumNotAddedTogether') }}</h2>
                <p>{{ describeMergedUsage(mergedUsage) }} · {{ mergedRows.length }} {{ t('costCenter.text.cells') }}<template v-if="mergedBackfilledRows.length"> · {{ mergedBackfilledRows.length }} {{ t('costCenter.text.cellsCompletedBySessionSource') }}</template></p>
              </div>
              <div v-if="!reconcileLoaded" class="cost-empty"><LoaderCircle :size="18" class="cost-spin" /><span>{{ t('costCenter.text.loadingMergedUsage') }}</span></div>
              <div v-else-if="!mergedUsage || !mergedUsage.available" class="cost-empty"><span>{{ t('costCenter.text.mergedUsageUnavailable') }}{{ mergedUsage?.reason ?? t('costCenter.text.ledgerNotGenerated') }}</span></div>
              <template v-else>
                <div class="cost-import-result" :class="mergedUsage.cells.length > 0 ? 'is-success' : ''" style="margin-bottom:10px;">
                  <strong>{{ t('costCenter.text.policyDailyModelMaximum') }}</strong> · {{ mergedCoverageLabel }}
                  <small style="display:block; opacity:.78; margin-top:3px;">
                    {{ t('costCenter.text.completedBySessionSource') }} {{ formatTokens(mergedUsage.coverage.sessionsBackfilledTokens) }} token / {{ mergedUsage.coverage.sessionsBackfilledDays }} {{ t('costCenter.text.daysMissingFromLogs') }}
                  </small>
                  <small style="display:block; opacity:.62; margin-top:2px;">{{ mergedLongRatioHint }}</small>
                  <small v-if="mergedUsage.windowStartMs && mergedUsage.windowEndMs" style="display:block; opacity:.62; margin-top:2px;">
                    {{ t('costCenter.text.coverage2') }} {{ formatUtcDay(mergedUsage.windowStartMs) }} → {{ formatUtcDay(mergedUsage.windowEndMs) }}{{ t('costCenter.text.utc') }}
                  </small>
                </div>

                <div v-if="mergedRows.length === 0" class="cost-empty"><span>{{ mergedUsage.reason ?? t('costCenter.text.noUsageDataInTheLedgerYet') }}</span></div>
                <div v-else class="cost-table-scroll">
                  <table class="cost-table">
                    <thead>
                      <tr>
                        <th>{{ t('costCenter.text.dateUtc') }}</th>
                        <th>{{ t('costCenter.text.model') }}</th>
                        <th>{{ t('costCenter.text.source2') }}</th>
                        <th class="num">{{ t('costCenter.text.longContextShare') }}</th>
                        <th class="num">Token</th>
                        <th class="num">logs</th>
                        <th class="num">sessions</th>
                        <th class="num">{{ t('costCenter.text.requests') }}</th>
                        <th class="num">{{ t('costCenter.text.costCatalogLocalReferencePrices') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="item in mergedPricedRows" :key="`${item.row.dayBucketMs}-${item.row.modelId}-${item.row.sourceAccountId}-${item.row.apiKeyId}`">
                        <td><small>{{ item.row.day }}</small></td>
                        <td><strong>{{ item.row.modelId || t('costCenter.text.emptyModel') }}</strong><small v-if="item.row.sourceAccountId">{{ item.row.sourceAccountId }}</small></td>
                        <td>
                          <small>{{ MERGE_WINNER_LABELS[item.row.winner] ?? item.row.winner }}</small>
                          <small v-if="item.row.bothPresent" class="cost-muted">{{ t('costCenter.text.maximumOfTwoSources') }}</small>
                          <small v-else class="cost-muted">{{ t('costCenter.text.singleSourceFallback') }}</small>
                        </td>
                        <td class="num">
                          <small>{{ item.longRatio == null ? '—' : `${(item.longRatio * 100).toFixed(1)}%` }}</small>
                        </td>
                        <td class="num">{{ formatTokens(item.row.totalTokens) }}</td>
                        <td class="num"><small>{{ formatTokens(item.row.logsTokens) }}</small></td>
                        <td class="num"><small>{{ formatTokens(item.row.sessionsTokens) }}</small></td>
                        <td class="num">{{ formatInteger(item.row.requests) }}</td>
                        <td class="num">
                          <template v-if="item.cost.basis.kind === 'no_price_no_estimate'">
                            <span class="cost-warning-text">{{ t('costCenter.text.costUnknown') }}</span>
                          </template>
                          <template v-else>
                            {{ formatUsd(item.cost.cost, 2) }}
                          </template>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <small class="cost-muted" style="display:block; margin-top:6px;">
                  {{ t('costCenter.text.mergedLayerProvidesUsageOnlyCostsAreCalculated') }} <code>cockpitSplitCostUsd() × cockpitPriceBook</code> {{ t('costCenter.text.usingTheSameParametersAsTheDirectSource') }}
                </small>
              </template>
            </div>

            <!-- 渠道配额(P0-21):cockpit 落盘快照 → 每个渠道账号"用了多少"。
                 默认零外网请求;只有点"立即刷新"才走实时路径 A,失败降级并提示。
                 UI 铁律:每条用量都标来源类型与数据时间戳;不可得显示"用量不可得"而不是 0%。 -->
            <div class="cost-table-wrap">
              <div class="cost-section-heading">
                <span>{{ t('costCenter.text.channelQuotas') }}</span>
                <h2>{{ t('costCenter.text.channelUsageProgress') }}</h2>
                <p>{{ t('costCenter.text.savedSnapshotsNoExternalRequestsChecked') }} {{ quotaActiveChannels.length }} {{ t('costCenter.text.channelsWithAccounts') }}<template v-if="quotaStaleCount"> · {{ quotaStaleCount }} {{ t('costCenter.text.possiblyStale') }}</template><template v-if="quotaUnavailableCount"> · {{ quotaUnavailableCount }} {{ t('costCenter.text.withUnavailableUsage') }}</template></p>
              </div>
              <div v-if="quotaLiveError" class="cost-import-result" style="margin-bottom:8px;">{{ t('costCenter.text.liveRefreshFailedSavedSnapshotsUsed') }}{{ quotaLiveError }}</div>
              <div v-if="quotaError" class="cost-import-result" style="margin-bottom:8px;">{{ quotaError }}</div>
              <div v-if="quotaLoading && !quotaLoaded" class="cost-empty"><LoaderCircle :size="18" class="cost-spin" /><span>{{ t('costCenter.text.loadingChannelQuotas') }}</span></div>
              <div v-else-if="quotaActiveChannels.length === 0" class="cost-empty"><span>{{ t('costCenter.text.noChannelsWithAccountsDetectedCockpitChannelAccounts') }}</span></div>
              <div v-else class="cost-table-scroll">
                <table class="cost-table">
                  <thead><tr><th>{{ t('costCenter.text.channel') }}</th><th>{{ t('costCenter.text.account3') }}</th><th>Plan</th><th>{{ t('costCenter.text.current') }}</th><th>{{ t('costCenter.text.group') }}</th><th>{{ t('costCenter.text.model') }}</th><th class="num">{{ t('costCenter.text.remaining') }}</th><th>{{ t('costCenter.text.dataSourceTimestamp') }}</th><th>{{ t('costCenter.text.window') }}</th><th></th></tr></thead>
                  <tbody>
                    <template v-for="c in quotaActiveChannels" :key="c.channel">
                      <tr v-for="(s, i) in (quotaSnapshotsByChannel[c.channel] || [])" :key="`${c.channel}:${s.accountId}:${s.modelId}:${i}`">
                        <td><strong>{{ c.channel }}</strong><small>{{ c.accountCount }} {{ t('costCenter.text.accounts3') }} {{ c.percentKind === 'used' ? t('costCenter.text.originallyUsed') : c.percentKind === 'remaining' ? t('costCenter.text.originallyRemaining') : t('costCenter.text.semanticsNotRecorded') }}</small></td>
                        <td><strong>{{ s.email || s.accountId || '—' }}</strong><small>{{ s.accountId }}</small></td>
                        <td><span v-if="s.plan" class="cost-badge" :class="planBadgeClass(s.plan)">{{ s.plan }}</span><small v-else class="cost-muted">—</small></td>
                        <td><span v-if="currentAccountIdFor(quotaCurrentAccounts, c.channel) === s.accountId" class="cost-badge">{{ t('costCenter.text.current') }}</span><small v-else class="cost-muted">—</small></td>
                        <td><small class="cost-muted">{{ groupLabelsFor(quotaAccountGroups, s.accountId).join(' / ') || '—' }}</small></td>
                        <td>{{ s.modelId || s.displayName || t('costCenter.text.accountLevel') }}</td>
                        <td class="num">
                          <strong :class="s.percent == null ? 'cost-muted' : (s.percent <= 20 ? 'cost-warning-text' : 'cost-lime')">{{ quotaPercentLabel(s) }}</strong>
                          <small v-if="s.unavailableReason" class="cost-muted">{{ s.unavailableReason }}</small>
                        </td>
                        <td><small>{{ quotaStampLabel(s) }}</small><small class="cost-muted">{{ s.rawKind }}</small></td>
                        <td><small>{{ quotaWindowLabel(s.windowKind) }}</small><small v-if="s.resetAtMs" class="cost-muted">{{ t('costCenter.text.reset') }} {{ formatCompactDate(s.resetAtMs) }}</small></td>
                        <td><button v-if="i === 0" type="button" class="cost-icon-button" :disabled="quotaRefreshingChannel === c.channel" :title="t('costCenter.text.refreshUsageNowLivePathSavedSnapshotsOn')" @click="refreshChannelQuota(c.channel)"><RefreshCcw :size="13" :class="{ 'cost-spin': quotaRefreshingChannel === c.channel }" /></button></td>
                      </tr>
                      <tr v-if="!(quotaSnapshotsByChannel[c.channel] || []).length"><td colspan="10" class="cost-empty-row">{{ c.channel }} {{ t('costCenter.text.noUsableQuotaSnapshotAccountDetailsNotSaved') }}</td></tr>
                    </template>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 导入结果提示(导入按钮已移到上游排行页面) -->
            <div v-if="importResult" class="cost-import-result" :class="importResult.added > 0 ? 'is-success' : ''" style="margin-bottom: 12px;">{{ importResult.message }}</div>

            <div class="cost-table-wrap">
              <div class="cost-section-heading"><span>{{ t('costCenter.text.localGatewayKeys') }}</span><h2>{{ t('costCenter.text.apiKeyUsage') }}</h2><p>{{ t('costCenter.text.requestsTokensActualCumulativeStatsApikeysTokensConsumed') }}</p></div>
              <div class="cost-table-scroll">
                <table class="cost-table">
                  <thead><tr><th>Label</th><th>Key</th><th class="num">{{ t('costCenter.text.tokenUsage') }}</th><th class="num">{{ t('costCenter.text.cumulativeRequests') }}</th><th class="num">{{ t('costCenter.text.successRate') }}</th><th class="num">{{ t('costCenter.text.cumulativeCost') }}</th><th>{{ t('costCenter.text.inheritedPool') }}</th><th>{{ t('costCenter.text.status') }}</th><th>{{ t('costCenter.text.lastUsed') }}</th></tr></thead>
                  <tbody>
                    <tr v-for="k in cockpitApiKeyRows" :key="k.id">
                      <td><strong>{{ k.label || k.id }}</strong><small>{{ k.id }}</small></td>
                      <td><code v-if="k.key">{{ maskCockpitKey(k.key) }}</code> <button v-if="k.key" type="button" class="cost-icon-button" :title="t('costCenter.text.copyFullKey')" @click="copyToClipboard(k.key)"><Copy :size="13" /></button><small v-else>{{ t('costCenter.text.statsRecordOnlyNoKeyMaterial') }}</small></td>
                      <td class="num">{{ formatTokens(k.tokenUsed ?? k.stat?.usage.totalTokens) }}</td>
                      <td class="num">{{ k.stat ? formatInteger(k.stat.usage.requestCount) : '—' }}</td>
                      <td class="num">{{ k.stat && k.stat.usage.requestCount > 0 ? `${((k.stat.usage.successCount / k.stat.usage.requestCount) * 100).toFixed(1)}%` : '—' }}</td>
                      <td class="num"><template v-if="k.costBasis === 'no_price_no_estimate'">{{ t('costCenter.text.costUnknown') }}<small class="cost-muted">{{ t('costCenter.text.noUnitPriceOrSourceEstimate') }}</small></template><template v-else>{{ formatUsd(k.costUsd, 2) }}<small v-if="!k.costIsOurs" class="cost-muted">{{ t('costCenter.text.sourceEstimate') }}</small></template></td>
                      <td>{{ k.inheritAccountPool == null ? '—' : k.inheritAccountPool ? t('costCenter.text.yes') : t('costCenter.text.no') }}</td>
                      <td><span class="cost-badge" :class="k.enabled ? 'plan-plus' : 'plan-unknown'">{{ k.enabled ? t('costCenter.text.enabled') : k.enabled === undefined ? '—' : t('costCenter.text.disabled') }}</span></td>
                      <td><small>{{ k.lastUsedAt ? formatCompactDate(k.lastUsedAt) : k.stat?.updatedAt ? formatCompactDate(k.stat.updatedAt) : '—' }}</small></td>
                    </tr>
                    <tr v-if="cockpitApiKeyRows.length === 0"><td colspan="9" class="cost-empty-row">{{ t('costCenter.text.noApiKeys') }}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div class="cost-table-wrap">
              <div class="cost-section-heading"><span>{{ t('costCenter.text.modelPricing') }}</span><h2>{{ t('costCenter.text.modelPricingCatalog') }}</h2><p>{{ t('costCenter.text.unitPricesPerMillionUsdCatalogLocalReference') }}</p></div>
              <div class="cost-table-scroll">
                <table class="cost-table">
                  <thead><tr><th>{{ t('costCenter.text.model') }}</th><th>{{ t('costCenter.text.group') }}</th><th class="num">{{ t('costCenter.text.input') }}</th><th class="num">{{ t('costCenter.text.output3') }}</th><th class="num">{{ t('costCenter.text.cachedInput') }}</th><th class="num">{{ t('costCenter.text.longContextThreshold') }}</th><th class="num">{{ t('costCenter.text.cumulativeRequests') }}</th><th class="num">{{ t('costCenter.text.cumulativeTokens') }}</th><th class="num">{{ t('costCenter.text.cumulativeCost') }}</th></tr></thead>
                  <tbody>
                    <tr v-for="m in cockpitPricingRows" :key="m.modelId">
                      <td><strong>{{ m.modelId }}</strong><small v-if="!m.pricing" class="cost-muted">{{ t('costCenter.text.noUsableReferencePriceSourceEstimateUsed') }}</small><small v-else-if="m.pricing.origin === 'local'" class="cost-muted">{{ t('costCenter.text.localOverridePrice') }}</small><small v-else class="cost-muted">{{ t('costCenter.text.catalogLocalReferencePrice') }}</small></td>
                      <td><small v-if="modelGroupLabelFor(quotaModelGroups, m.modelId)" class="cost-muted">{{ modelGroupLabelFor(quotaModelGroups, m.modelId) }}</small><small v-else class="cost-muted">—</small></td>
                      <td class="num">{{ m.pricing ? cockpitPricePerMillion(m.pricing.inputUsdPerMillion) : '—' }}</td>
                      <td class="num">{{ m.pricing ? cockpitPricePerMillion(m.pricing.outputUsdPerMillion) : '—' }}</td>
                      <td class="num">{{ m.pricing ? cockpitPricePerMillion(m.pricing.cachedInputUsdPerMillion) : '—' }}</td>
                      <td class="num">{{ m.pricing ? formatTokens(m.pricing.longContextThresholdTokens) : '—' }}</td>
                      <td class="num">{{ m.usage ? formatInteger(m.usage.requestCount) : '—' }}</td>
                      <td class="num">{{ m.usage ? formatTokens(m.usage.totalTokens) : '—' }}</td>
                      <td class="num"><template v-if="m.costBasis === 'no_price_no_estimate' && !m.costPartial">{{ t('costCenter.text.costUnknown') }}<small class="cost-muted">{{ t('costCenter.text.noUnitPriceOrSourceEstimate') }}</small></template><template v-else>{{ formatUsd(m.costUsd, 2) }}<small v-if="m.costPartial" class="cost-muted">{{ t('costCenter.text.knownPortionIncludesUnpricedUsage') }}</small><small v-else-if="!m.costIsOurs" class="cost-muted">{{ t('costCenter.text.sourceEstimate') }}</small></template></td>
                    </tr>
                    <tr v-if="cockpitPricingRows.length === 0"><td colspan="9" class="cost-empty-row">{{ t('costCenter.text.noPricingCatalog') }}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- 价目对账(缺口 ③):把 cockpit 当时**实际使用**的三档单价与本项目
                 cockpitPriceBook.ts 逐模型比对。只提示,不改成本 —— 计价唯一入口仍是
                 cockpitSplitCostUsd() × cockpitPriceBook.ts(红线)。 -->
            <div class="cost-table-wrap">
              <div class="cost-section-heading">
                <span>{{ t('costCenter.text.priceReconciliation') }}</span>
                <h2>{{ t('costCenter.text.appPricesVsSourceUnitPriceSnapshots') }}</h2>
                <p>{{ priceReconcile.summary }}</p>
              </div>
              <div v-if="!facetsLoaded" class="cost-empty"><LoaderCircle :size="18" class="cost-spin" /><span>{{ t('costCenter.text.loadingUnitPriceSnapshots') }}</span></div>
              <div v-else-if="!facets || !facets.available" class="cost-empty"><span>{{ t('costCenter.text.unitPriceSnapshotsUnavailable') }}{{ facets?.reason ?? t('costCenter.text.requestLogsDimensionsNotLoaded') }}</span></div>
              <div v-else-if="priceReconcile.rows.length === 0" class="cost-empty"><span>{{ t('costCenter.text.sourceDoesNotProvideUnitPriceSnapshotsThis') }}</span></div>
              <div v-else class="cost-table-scroll">
                <table class="cost-table">
                  <thead><tr><th>{{ t('costCenter.text.model') }}</th><th>{{ t('costCenter.text.tier') }}</th><th>{{ t('costCenter.text.result') }}</th><th class="num">{{ t('costCenter.text.inputAppSource') }}</th><th class="num">{{ t('costCenter.text.cachedInputAppSource') }}</th><th class="num">{{ t('costCenter.text.outputAppSource') }}</th><th class="num">{{ t('costCenter.text.requests4') }}</th></tr></thead>
                  <tbody>
                    <template v-for="row in priceReconcile.rows" :key="row.model">
                      <tr>
                        <td :rowspan="row.long ? 2 : 1">
                          <strong>{{ row.model }}</strong>
                          <small>{{ formatInteger(row.cockpitRows) }} {{ t('costCenter.text.requests5') }}<template v-if="row.pricingVersions.length"> {{ t('costCenter.text.version2') }} {{ row.pricingVersions.join('/') }}</template></small>
                        </td>
                        <td>{{ PRICE_TIER_LABELS.standard }}</td>
                        <td>
                          <span class="cost-badge" :class="priceStatusClass(row.standard.status)">{{ PRICE_RECONCILE_STATUS_LABELS[row.standard.status] }}</span>
                          <small v-if="row.standard.differingFields.length">{{ t('costCenter.text.mismatch') }}{{ row.standard.differingFields.join(t('costCenter.text.label3')) }}</small>
                        </td>
                        <td class="num">{{ pricePair(row.standard.ours?.input, row.standard.cockpit?.input) }}</td>
                        <td class="num">{{ pricePair(row.standard.ours?.cached, row.standard.cockpit?.cached) }}</td>
                        <td class="num">{{ pricePair(row.standard.ours?.output, row.standard.cockpit?.output) }}</td>
                        <td class="num">{{ formatInteger(row.standard.rows) }}</td>
                      </tr>
                      <tr v-if="row.long">
                        <td>{{ PRICE_TIER_LABELS.long }}<small v-if="row.long.variantCount > 1">{{ t('costCenter.text.label7') }}{{ row.long.variantCount }} {{ t('costCenter.text.priceGroups') }}</small></td>
                        <td>
                          <span class="cost-badge" :class="priceStatusClass(row.long.status)">{{ PRICE_RECONCILE_STATUS_LABELS[row.long.status] }}</span>
                          <small v-if="row.long.differingFields.length">{{ t('costCenter.text.mismatch') }}{{ row.long.differingFields.join(t('costCenter.text.label3')) }}</small>
                        </td>
                        <td class="num">{{ pricePair(row.long.ours?.input, row.long.cockpit?.input) }}</td>
                        <td class="num">{{ pricePair(row.long.ours?.cached, row.long.cockpit?.cached) }}</td>
                        <td class="num">{{ pricePair(row.long.ours?.output, row.long.cockpit?.output) }}</td>
                        <td class="num">{{ formatInteger(row.long.rows) }}</td>
                      </tr>
                    </template>
                  </tbody>
                </table>
              </div>
              <small class="cost-muted" style="display:block; margin-top:6px;">{{ t('costCenter.text.reconciliationOnlyIndicatesPossibleStalePricesAndDoes') }}</small>
            </div>

            <!-- 失败原因完整分类(缺口 ③):request_logs.error_category 实有 12 类,
                 而 TokenSplit 只单独计数 3 类 —— request_failed(本机 4,212 条)
                 此前只能落进"其他 error",在 UI 上彻底看不见。 -->
            <div class="cost-table-wrap">
              <div class="cost-section-heading">
                <span>{{ t('costCenter.text.failureReasons') }}</span>
                <h2>{{ t('costCenter.text.requestFailureCategoriesFullWindow') }}</h2>
                <p>{{ failureBreakdownSummary }}</p>
              </div>
              <div v-if="!facetsLoaded" class="cost-empty"><LoaderCircle :size="18" class="cost-spin" /><span>{{ t('costCenter.text.loadingFailureCategories') }}</span></div>
              <div v-else-if="!facets || !facets.available" class="cost-empty"><span>{{ t('costCenter.text.failureCategoriesUnavailable') }}{{ facets?.reason ?? t('costCenter.text.requestLogsDimensionsNotLoaded') }}</span></div>
              <template v-else>
                <div v-if="errorCategoryUnavailable" class="cost-empty"><span>{{ t('costCenter.text.thisCockpitVersionLacksErrorCategoryFailureReasons') }}</span></div>
                <div v-else-if="errorCategoryDistribution.length === 0" class="cost-empty"><span>{{ t('costCenter.text.noFailedRequestsInTheSelectedPeriod') }}</span></div>
                <div v-else class="cost-table-scroll">
                  <table class="cost-table">
                    <thead><tr><th>{{ t('costCenter.text.failureReasons') }}</th><th class="num">{{ t('costCenter.text.count') }}</th><th class="num">{{ t('costCenter.text.shareOfClassifiedFailures') }}</th></tr></thead>
                    <tbody>
                      <tr v-for="r in errorCategoryDistribution" :key="r.key">
                        <td><strong>{{ r.label }}</strong><small v-if="r.label !== r.key">{{ r.key }}</small></td>
                        <td class="num">{{ formatInteger(r.count) }}</td>
                        <td class="num">{{ r.share == null ? '—' : `${(r.share * 100).toFixed(1)}%` }}</td>
                      </tr>
                      <tr v-if="facets.failedWithoutCategory > 0">
                        <td><strong>{{ t('costCenter.text.unclassifiedFailures') }}</strong><small>{{ t('costCenter.text.errorCategoryEmpty') }}</small></td>
                        <td class="num">{{ formatInteger(facets.failedWithoutCategory) }}</td>
                        <td class="num">—</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <!-- 诊断维度:有量才显示,缺列时如实标注而不是显示 0 -->
                <div class="cost-facet-chips">
                  <div v-if="reasoningTokensUnavailable" class="cost-facet-chip is-muted">
                    <span>{{ t('costCenter.text.reasoningTokens') }}</span>
                    <strong>{{ t('costCenter.text.notProvidedByThisVersion') }}</strong>
                    <small>{{ t('costCenter.text.cockpitLacksReasoningTokens') }}</small>
                  </div>
                  <div v-else class="cost-facet-chip">
                    <span>{{ t('costCenter.text.reasoningTokens') }}</span>
                    <strong>{{ formatTokens(facets.reasoningTokens) }}</strong>
                    <small>{{ formatInteger(facets.reasoningRows) }} {{ t('costCenter.text.requestsASubsetOfOutputTokensNotPriced') }}</small>
                  </div>
                  <div v-if="reasoningEffortUnavailable" class="cost-facet-chip is-muted">
                    <span>{{ t('costCenter.text.reasoningEffort') }}</span>
                    <strong>{{ t('costCenter.text.notProvidedByThisVersion') }}</strong>
                    <small>{{ t('costCenter.text.cockpitLacksReasoningEffort') }}</small>
                  </div>
                  <div v-else class="cost-facet-chip">
                    <span>{{ t('costCenter.text.reasoningEffort') }}</span>
                    <strong>{{ reasoningEffortDistribution.length ? reasoningEffortDistribution[0].label : t('costCenter.text.noData') }}</strong>
                    <small>{{ t('costCenter.text.largestShare') }}{{ reasoningEffortDistribution.length > 1 ? t('costCenter.text.effortLevels', { value0: reasoningEffortDistribution.length }) : '' }}</small>
                  </div>
                  <div v-if="gatewayModeUnavailable" class="cost-facet-chip is-muted">
                    <span>{{ t('costCenter.text.gatewayChannels') }}</span>
                    <strong>{{ t('costCenter.text.notProvidedByThisVersion') }}</strong>
                    <small>{{ t('costCenter.text.cockpitLacksGatewayMode') }}</small>
                  </div>
                  <div v-else class="cost-facet-chip">
                    <span>{{ t('costCenter.text.gatewayChannels') }}</span>
                    <strong>{{ gatewayModeDistribution.map((g) => `${g.label.split('（')[0]} ${formatInteger(g.count)}`).join(' · ') || t('costCenter.text.noData') }}</strong>
                    <small>{{ t('costCenter.text.legacyRequestsUsingTheLegacyGateway') }}</small>
                  </div>
                  <!-- 请求类型(request_kind):Rust 侧一直有返回,此前前端零消费。
                       空值在 Rust 聚合时已被丢弃,不并入任何一类;未收录的取值原样显示。 -->
                  <div v-if="requestKindUnavailable" class="cost-facet-chip is-muted">
                    <span>{{ t('costCenter.text.requestTypes') }}</span>
                    <strong>{{ t('costCenter.text.notProvidedByThisVersion') }}</strong>
                    <small>{{ t('costCenter.text.cockpitLacksRequestKind') }}</small>
                  </div>
                  <div v-else class="cost-facet-chip">
                    <span>{{ t('costCenter.text.requestTypes') }}</span>
                    <strong>{{ requestKindDistribution.map((k) => `${k.label} ${formatInteger(k.count)}`).join(' · ') || t('costCenter.text.noData') }}</strong>
                    <small>{{ t('costCenter.text.requestKindDistributionMissingValuesNotCountedOr') }}</small>
                  </div>
                </div>
              </template>
            </div>

            <div class="cost-table-wrap">
              <div class="cost-section-heading"><span>{{ t('costCenter.text.customUpstreams') }}</span><h2>{{ t('costCenter.text.customModelProviders') }}</h2><p>{{ t('costCenter.text.codexModelProvidersJsonThirdPartyOpenaiCompatible') }}</p></div>
              <div v-if="loading && cockpitModelProviders.length === 0" class="cost-empty"><LoaderCircle :size="20" class="cost-spin" /><span>{{ t('costCenter.text.loading') }}</span></div>
              <div v-else-if="cockpitModelProviders.length === 0" class="cost-empty"><span>{{ t('costCenter.text.noCustomModelProviders') }}</span></div>
              <div v-else class="cost-table-scroll">
                <table class="cost-table">
                  <thead><tr><th>{{ t('costCenter.text.name') }}</th><th>Base URL</th><th>{{ t('costCenter.text.apiProtocol') }}</th><th class="num">API Keys</th><th>{{ t('costCenter.text.vision') }}</th></tr></thead>
                  <tbody>
                    <tr v-for="p in cockpitModelProviders" :key="p.id">
                      <td><strong>{{ p.name || p.id }}</strong><small>{{ p.id }}</small></td>
                      <td><code>{{ p.baseUrl }}</code></td>
                      <td>{{ p.wireApi || '—' }}</td>
                      <td class="num">{{ formatInteger(p.apiKeys?.length) }}</td>
                      <!-- supportsVision 在 CockpitModelProvider 里是**可选**字段:
                           源没给这个字段 ≠ 该提供商不支持视觉。此前 `? '支持' : '否'`
                           把「未知」说成「否」——编造了一个否定结论。
                           同表 wireApi / inheritAccountPool 都走 `== null ? '—'`。 -->
                      <td>{{ p.supportsVision == null ? '—' : p.supportsVision ? t('costCenter.text.supported') : t('costCenter.text.notSupported') }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </template>
        </section>

        <section v-else class="cost-workspace cost-api-workspace" aria-labelledby="api-access-title">
          <CostApiAccessPanel :desktop-mode="desktopMode" :ops-overview="opsOverview" />
        </section>
      </main>

      <CostProfileInspector
        :source-kind="costSourceKind"
        :account="selectedAccount"
        :account-count="bulkCostEdit ? selectedAccountIds.size : undefined"
        :saving="saving"
        :now="now"
        data-aui-component="popover"
        data-aui-layer="functional"
        data-aui-adaptive-region="inspector"
        data-aui-source-id="cost-profile-trigger"
        @close="closeCostProfileInspector"
        @save="saveSelectedCostProfile"
      />
    </div>
  </component>
</template>

<script setup lang="ts">
import ConsoleWorkspaceHeader from '@/features/desktop/ConsoleWorkspaceHeader.vue'
import '@/styles/console-theme.css'
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import {
  Activity,
  ArrowLeft,
  ArrowLeftRight,
  BarChart3,
  Calculator,
  CircleCheck,
  Database,
  ExternalLink,
  FlaskConical,
  Gauge,
  KeyRound,
  Layers,
  LoaderCircle,
  Maximize2,
  Plus,
  RefreshCcw,
  ReceiptText,
  Search,
  Settings2,
  ShoppingBag,
  TriangleAlert,
  TrendingUp,
  Trophy,
  Copy,
  Upload,
} from '@lucide/vue'
import type { CockpitImportResult } from '@/api/cockpit'
import { cockpitLocalDate, getCockpitOpsSummary, getCockpitRequestLogSummary, importCockpitCodexAccounts, importCockpitRoutingRules } from '@/api/cockpit'
import type { OpsThroughputTrendPoint } from '@/api/admin/ops'
import type { AccountEconomicsSnapshot } from '@/api/admin/accounts'
import AppLayout from '@/components/layout/AppLayout.vue'
import { formatDate as formatDateByLocale, formatNumberLocaleString } from '@/utils/format'
import { useAppStore } from '@/stores'
import { useConnectionStore } from '@/stores/connection'
import type { AccountUsageInfo } from '@/types'
import type { SourceAccount as Account, CostAccountId } from '@/features/cost-center/sourceTypes'
import { costAccountGroupNames } from '@/features/cost-center/accountIdentity'
import type { ChannelModelPricing, ModelDefaultPricing } from '@/api/admin/channels'
import CostLineChart from '@/features/cost-center/components/CostLineChart.vue'
import AdaptiveOperationsCharts from '@/features/cost-center/components/AdaptiveOperationsCharts.vue'
// 渠道配额(P0-21):把 cockpit_quota.rs 的四个命令接成可直接渲染的状态
import { useChannelQuota } from '@/features/cost-center/useChannelQuota'
import { quotaWindowState, type QuotaWindowReading } from '@/features/cost-center/quotaWindowState'
import {
  formatAgeMs,
  quotaAgeMs,
  quotaPercentLabel,
  quotaStampLabel,
  quotaWindowLabel,
  // 「当前账号」与「模型分组」(2026-09-15):cockpit 的两个「使用数据」源。
  getQuotaCurrentAccounts,
  getQuotaModelGroups,
  getQuotaAccountGroups,
  currentAccountIdFor,
  modelGroupLabelFor,
  groupLabelsFor,
  type CurrentAccountEntry,
  type ModelGroups,
  type AccountGroups,
} from '@/api/cockpit/quota'
import {
  mergeIdenticalQuotaChannels,
  quotaSnapshotSetSignature,
  type QuotaChannelChip,
} from '@/api/cockpit/quotaChannelMerge'
import ModelContributionChart from '@/features/cost-center/components/ModelContributionChart.vue'
import CostApiAccessPanel from '@/features/cost-center/components/CostApiAccessPanel.vue'
import CostProfileInspector from '@/features/cost-center/components/CostProfileInspector.vue'
import MetricCell from '@/features/cost-center/components/TruthfulMetric.vue'
import AssetCostOverview from '@/features/cost-center/components/AssetCostOverview.vue'
import DataGovernancePanel from '@/features/cost-center/components/DataGovernancePanel.vue'
import CostEventsPanel from '@/features/cost-center/components/CostEventsPanel.vue'
import { getFinanceLedger, type FinanceSnapshot } from '@/api/financeLedger'
import { getModelCatalogStatus, refreshModelCatalog, type ModelCatalogStatus } from '@/api/modelCatalog'
import { monitorMode, monitorContext } from '@/api/usageMonitor'
import UpstreamProbeCell from '@/features/cost-center/components/UpstreamProbeCell.vue'
import {
  actualUserCost,
  standardReferenceCost,
  COST_ALGORITHM_VERSION,
  convertCurrency,
  elapsedHours,
  formatMoney,
  inferPlan,
  isDefaultSubscriptionCostProfile,
  isStartedInLocalMonth,
  resolveAccountBillingMode,
  resolveFallbackCostProfile,
  sumAccountCostUsd,
  summarizeKnownAmounts,
  UNKNOWN_PLAN_FALLBACK_USD,
  UNATTRIBUTED_USAGE_ACCOUNT_ID,
  type AccountWindowUsage,
  type CostProfile,
  type AmountSummary,
} from '@/features/cost-center/model'
import {
  DEFAULT_COST_CENTER_RANGE,
  USAGE_LOGS_SAFE_READ_CAP,
  useCostCenterData,
  type CostCenterRange,
} from '@/features/cost-center/useCostCenterData'
import { loadUsdCnyExchangeRate, saveUserOverrideRate, clearUserOverrideRate } from '@/features/cost-center/exchangeRate'
import { costTrendBucketHours as resolveCostTrendBucketHours, usageWindowBounds, usageWindowHours, usageBucketHours, parseTrendDate, costCenterRangeLabel } from '@/features/cost-center/usageWindow'
// 缺口 ③:request_logs 未读维度(失败全量分类 / 单价快照对账 / 推理档位 / 网关通道 / 请求类型)
import {
  describeFailureBreakdown,
  errorCategoryRows,
  facetDimensionUnavailable,
  gatewayModeRows,
  getRequestLogFacets,
  reasoningEffortRows,
  requestKindRows,
  type CockpitRequestLogFacets,
} from '@/api/cockpit/facets'
import { PRICE_RECONCILE_STATUS_LABELS, PRICE_TIER_LABELS, reconcileCockpitPrices, type PriceReconcileStatus } from '@/features/cost-center/priceReconcile'
// P0-25 多源对账:账本读取层(只出证据,不合并 —— 合并口径 P0-15 被本项阻塞)
import {
  describeReconcile,
  formatDivergence,
  formatUtcDay,
  listLedgerSources,
  reconcileCellRows,
  reconcileLedgerSources,
  reconcileVerdictTone,
  RECONCILE_VERDICT_LABELS,
  type LedgerSourceInfo,
  type ReconcileResult,
} from '@/api/ledgerQuery'
// P0-15 多源合并口径:按「天(UTC) × 模型」取两源 token 更大的那个源(不相加)
import {
  describeMergedUsage,
  mergedCellRows,
  mergedLedgerUsage,
  MERGE_WINNER_LABELS,
  isSessionsWinner,
  tierVectorLong,
  type MergedCellRow,
  type MergedUsageResult,
} from '@/api/ledgerMerge'
// 合并口径 → 计价的唯一衔接层:钱只在前端算,且必须走 cockpitSplitCostUsd() × cockpitPriceBook
import {
  mergeCoverageLabel,
  mergedCellCost,
  mergeLongRatioHint,
} from '@/features/cost-center/mergeUsage'
import { selectFinancialTrend } from '@/features/cost-center/financialTrend'
import { finiteOrNull, hasMeasuredData, poolHealthStateFor, probeAvailabilityNote, sourceState, sumFiniteTrendValues, unavailableValueLabel, type DataAvailability, type DataSourceState } from '@/features/cost-center/dataState'
import {
  averageQuotaRemaining,
  formatPercentOrDash,
  formatUtilization,
  latencySampleMs,
  pickMostStaleSnapshot,
  quotaGrade,
  quotaRemainingRatio,
  quotaStaleNotice,
  resolveCostCell,
  resolveQualityScore,
  resolveRequestCounts,
  truthfulState,
  UNKNOWN_DASH,
  utilizationBarWidth,
} from '@/features/cost-center/honestValues'
import { routeCostBasisLabel, type ModelRouteRow } from '@/features/cost-center/modelRouteAnalysis'
import { resolveRowUsageSuffix, resolveUsageStatsFor } from '@/features/cost-center/accountRowUsageBasis'
import { useUnifiedCost, type SourceStatus, type CostUnit } from '@/features/cost-center/useUnifiedCost'
import { summarizeOperatingCosts, type OperatingAccount, type OperatingSummary } from '@/features/cost-center/costEngine'
import { recordedAccountCosts, sumCompleteCosts } from '@/features/cost-center/recordedCosts'
import type { CockpitPlatformAccountInput } from '@/features/cost-center/cockpitAdapter'
import { applyCockpitUsageLedger, cockpitOpsSummaryToTrend, cockpitOpsAccountsToRequestCounts, clipOpsBucketsToWindow, statsAccountCostId, cockpitSnapshotsToAccountUsage } from '@/features/cost-center/cockpitAdapter'
import { getAuthFiles, getRoutingStrategy, getDebug, getConfig, getApiKeyUsage, type AuthFile, type ApiKeyUsageBucket } from '@/api/cliproxy/management'
import { getCliproxyUsageSnapshot, getCliproxyModelPrices, type CliproxyUsageSnapshot, type LitellmPricing } from '@/api/cliproxy/cpaData'
import { getCockpitStats, getCockpitCodexAccounts, getCockpitGeminiAccounts, getCockpitAntigravityAccounts, getCockpitLocalAccess, getCockpitPlatformAccounts, getCockpitModelProviders, getCockpitApiLog, getCockpitQuotaHistories, getCockpitApiKeyNames, getCockpitAccountGroups, getCockpitCodexAccountGroups, readCostLedger, writeCostLedger, type CockpitStats, type CockpitCodexAccount, type CockpitGeminiAccount, type CockpitAntigravityAccount, type CockpitLocalAccess, type CockpitPlatformAccount, type CockpitModelProvider, type CockpitQuotaHistoryFile, type CockpitModelUsage, type CockpitOpsRouteAgg, type CockpitRequestLogSummary, type CockpitApiKeyStat, type CockpitUsageStats } from '@/api/cockpit'
// 本地持久账本(二期 Rust T11–T13)。此前无任何调用点 → 账本从未落盘。
import { describeLedgerIngest, ledgerAllUnavailableReason, ledgerIngestOnce, ledgerSourceDelivered, type LedgerIngestResult } from '@/api/ledger'
import { MAX_COCKPIT_LOG_LINES, cockpitSplitCostUsd, cockpitRequestLogToApiKeyStats, cockpitGroupNameByAccountId, cockpitWindowCoverage, cockpitCoverageNote, cockpitSnapshotWindowNote, cockpitWindowLabelForRange, cockpitWindowForRange } from '@/features/cost-center/cockpitAdapter'
// 计价依据「取更差一侧」的唯一实现(与 cockpitAdapter 逐账号/逐模型链路同一条判据):
// 自算累计成本里只要有**一部分**组没匹配到单价,那个总和就只是**下界**。
import { worstCostBasisKind, worseBasisOf, type CostBasisKind } from '@/features/cost-center/costBasis'
import { cockpitEffectiveModelPricings, cockpitEffectivePriceSets, cockpitPriceSetFor } from '@/features/cost-center/cockpitPriceBook'
import { planBadgeClass } from '@/features/cost-center/planBadge'
import { errMsg } from '@/stores/connection'
import { ACCOUNT_PURCHASE_URL, openProjectExternalUrl } from '@/features/desktop/externalLinks'
import { getLocale } from '@/i18n'
import {
  buildModelCostRows,
  describeCostAccountOrigin,
  summarizeModelCosts,
} from '@/features/cost-center/modelCostAnalysis'
import {
  describeCurrentAccountState,
  hasAccountRankingEvidence,
  latencyRankingProbe,
  normalizeSchedulerScore,
  resolveSchedulerBaseScoreMax,
} from '@/features/cost-center/upstreamTable'
import {
  buildAccountPoolProviderTabs,
  classifyUpstreamProvider,
  buildUpstreamProviderTabs,
  matchesAccountPoolProvider,
  matchesUpstreamProvider,
  providerLabels,
  type UpstreamProviderFilter,
  type UpstreamProviderKey,
} from '@/features/cost-center/upstreamProvider'

type WorkspaceKey = 'overview' | 'upstreams' | 'oauth' | 'governance' | 'finance' | 'api' | 'unified' | 'cliproxy-manage'
type RankingMetric = 'score' | 'output' | 'requests' | 'cost' | 'latency' | 'reliability'

const { t } = useI18n()

const ChartPanel = defineComponent({
  props: { title: String, caption: String },
  setup(props, { slots, attrs }) {
    return () => h('section', { ...attrs, class: ['cost-chart-panel', attrs.class] }, [
      h('div', { class: 'cost-panel-heading' }, [h('strong', props.title), h('span', props.caption ? ` · ${props.caption}` : '')]),
      slots.default?.(),
    ])
  },
})

const StatusLabel = defineComponent({
  props: { state: String, label: String },
  setup(props) {
    return () => h('div', { class: ['cost-status-label', `status-${props.state}`] }, [
      h('i'), h('strong', props.label || props.state),
      h('small', props.state),
    ])
  },
})

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const connectionStore = useConnectionStore()
const data = useCostCenterData()
const {
  accounts, costLossStates, accountEconomics: sourceAccountEconomics, accountUsage, trend, trendQueryWindow, trendUsesAccountCost, trendTruncated, cockpitWindowHours, cockpitTrendBucketHours, opsTrendFromRequestLog, cockpitWindowLabel, cockpitCostFromRequestLog, modelCostFromRequestLog, models, modelCostSource, modelCostRange, modelWindowDetached, loadCockpitModelWindow, detachModelWindow, modelCostAccountId, modelAuditMismatchOnly, modelCostControlsDisabled, modelAuditSummary, modelRoutes, modelRoutesTruncated, modelStatsExactWindowFallback, modelStatsCompatibilityTruncated, modelPricing, pricingStatus, pricingRefreshing, opsOverview, opsTrend, opsErrorTrend, cockpitHealthSeries, systemSettings, probes, sourceStates, loading, saving, error, lastUpdated, exchangeRate, cockpitCostMultiplier,
} = data
const fullscreenFailure = ref<string | null>(null)
const displayError = computed(() => fullscreenFailure.value == null ? error.value : t('costCenter.text.failedToToggleFullscreen', { value0: fullscreenFailure.value }))

// 渠道配额(PRD P0-21):cockpit 落盘快照 → 每个渠道账号"用了多少"。
// 默认零外网请求;只有用户点"立即刷新"才走实时路径 A,失败降级并提示。
const channelQuota = useChannelQuota()

/**
 * cockpit「当前账号」映射(provider_current_accounts.json + antigravity 运行时)。
 *
 * 空数组 = 读不到 → 该列全显示 `—`。**不显示"否"** —— "没读到"和"确定不是当前账号"
 * 是两件事,后者我们并不知道。
 */
const quotaCurrentAccounts = ref<CurrentAccountEntry[]>([])
/** cockpit 模型分组配置(group_settings.json)。null / available:false → 分组列全显示 `—`。 */
const quotaModelGroups = ref<ModelGroups | null>(null)
/**
 * cockpit 账号分组(account_groups.json 通用 + codex_account_groups.json 专用)。
 * 用户手动打的标签,我们只读展示。null / 无命中 → 显示 `—`。
 */
const quotaAccountGroups = ref<AccountGroups | null>(null)

/**
 * 与配额同批拉「当前账号」+「模型分组」。
 * 两个源各自失败各自吞掉 —— 它们只是两个附加列,不该拖垮成本主链路。
 */
async function loadCockpitAccountMeta(): Promise<void> {
  const [accounts, groups, accountGroups] = await Promise.all([
    getQuotaCurrentAccounts().catch(() => [] as CurrentAccountEntry[]),
    getQuotaModelGroups().catch(() => null),
    getQuotaAccountGroups().catch(() => null),
  ])
  quotaCurrentAccounts.value = accounts
  quotaModelGroups.value = groups
  quotaAccountGroups.value = accountGroups
}
const {
  activeChannels: quotaActiveChannels,
  snapshotsByChannel: quotaSnapshotsByChannel,
  unavailableCount: quotaUnavailableCount,
  staleCount: quotaStaleCount,
  loading: quotaLoading,
  loaded: quotaLoaded,
  error: quotaError,
  refreshingChannel: quotaRefreshingChannel,
  liveError: quotaLiveError,
  load: loadChannelQuota,
  refresh: refreshChannelQuota,
} = channelQuota

/** 资产总览用的渠道配额摘要:每渠道取"剩余最低"的那一档作为主值(最接近真实占用)。
 *  全为 null(不可得)时 worst=null —— UI 显示"用量不可得",**绝不显示 0%**。
 *
 *  ★ 2026-09-12 补 `ageDays`:cockpit 桌面缓存可能长期停更(实测本机停在 47 天前),
 *    此时百分比是**真数字但不是当前用量**。不把年龄标出来,用户会把 47 天前的
 *    「剩余 100%」当成现在还剩 100% —— 那是撒谎。取**最老**那条作保守估计。
 *
 *  ★ 2026-09-12 补「同源合并」:`antigravity` / `gemini` / `antigravity_ide` 在 Rust 侧
 *    共用同一个账号目录(cockpit_quota.rs 里三者都映射到 `accounts`),读的是同一份桌面缓存,
 *    快照集合**完全相同** —— UI 上就是 3 个一模一样的 chip 并排,纯噪音。
 *    这里把"快照集合签名完全一致"的渠道合成一个 chip(渠道名用 ` / ` 连接)。
 *    判定**保守**:只要有一丁点不同(含 percent 是 null 还是 0)就不合并;
 *    `accountCount` 取组内第一个而**不相加**(本来就是同一批账号,相加即虚增)。
 *  ★ 合并是**两步**:① 候选组 = 同一账号目录(`c.dir`,三者共用 `accounts/`);
 *    ② 组内**每个**成员的快照集合签名必须完全一致 —— 只要有一个对不上,
 *    整组逐个显示(不把"相同的那两个"悄悄合掉,那会让用户以为有差异的渠道不存在)。
 *    判定逻辑见 `@/api/cockpit/quotaChannelMerge`。 */
const quotaChannelSummaries = computed<QuotaChannelChip[]>(() => {
  const now = Date.now()
  const chips: QuotaChannelChip[] = quotaActiveChannels.value.map((c) => {
    const snaps = quotaSnapshotsByChannel.value[c.channel] ?? []
    const pcts = snaps.map((s) => s.percent).filter((p): p is number => p != null)
    const ages = snaps.map((s) => quotaAgeMs(s, now)).filter((a): a is number => a != null)
    const oldestAgeMs = ages.length ? Math.max(...ages) : null
    // 审查 #8:百分比与时间戳必须取自**同一条**快照。
    // 此前 worst 取 min(pcts)、stamp 取 snaps[0]、oldestAgeMs 取最老一条,
    // 三者可能各来自不同行 —— "剩余 X% · N 天前"里的两个数字其实互不相干。
    // 统一取"最老且有百分比"的那条(最保守),与 oldestAgeMs 对齐。
    const shown = pickMostStaleSnapshot(snaps, (s) => quotaAgeMs(s, now), (s) => s.percent != null, (s) => s.percent)
    return {
      channel: c.channel,
      /** 账号目录：**同源候选组的划分依据**（三者共用 `accounts/` 才会被判定为同源） */
      dir: c.dir,
      accountCount: c.accountCount,
      /** 与 stamp / ageLabel 同源:都来自 `shown` 这一条快照 */
      worst: shown?.percent ?? null,
      /** 有快照但一条百分比都拿不到 = 该渠道账号属"用量不可得" */
      allUnavailable: snaps.length > 0 && pcts.length === 0,
      hasSnapshot: snaps.length > 0,
      stamp: shown ? quotaStampLabel(shown) : null,
      /** 数据年龄(毫秒),null = 无从判断 */
      oldestAgeMs,
      ageLabel: oldestAgeMs != null ? formatAgeMs(oldestAgeMs) : '',
      /** ≥1 天即视为"陈旧到不能代表当前用量",UI 上转成灰色 + 标年龄 */
      ageDays: oldestAgeMs != null ? Math.floor(oldestAgeMs / 86_400_000) : 0,
      /** 仅用于同源合并判定,不参与渲染 */
      signature: quotaSnapshotSetSignature(snaps),
    }
  })
  return mergeIdenticalQuotaChannels(chips)
})

/**
 * 审查 #10:读取失败时**保留**旧数据(旧值 + 说明 > 空白),但必须说清它是上次成功的。
 *
 * `useChannelQuota.load()` 的 catch 只设 `error`、不清空 `snapshotsByChannel`,
 * 于是"先加载成功、再刷新失败"时,这里显示的仍是上一次的数字且毫无提示 ——
 * 用户会当成最新数据读。与 ageDays ≥ 1 同源:展示了数字却没说它还能不能信。
 *
 * 失败标记是**整条 strip 级**的,不是 per-chip:`quotaError` 是全局一次读取的结果,
 * 挂到单个渠道上会错误地暗示"只有这个渠道失败了"。
 */
const quotaTrust = computed(() => quotaStaleNotice(quotaError.value, quotaChannelSummaries.value.length > 0))

/** request_logs 未读维度汇总(缺口 ③)。null = 尚未读取 / 非桌面端。
 *  与 getCockpitRequestLogSummary 的 17.9 万行扫描相互独立,可单独失败。 */
const facets = ref<CockpitRequestLogFacets | null>(null)
const facetsLoaded = ref(false)
/** 价目对账结论。**只提示,不改成本** —— 计价唯一入口仍是 cockpitSplitCostUsd() × cockpitPriceBook.ts。 */
const priceReconcile = computed(() => reconcileCockpitPrices(facets.value?.priceSnapshots))
const failureBreakdownSummary = computed(() => describeFailureBreakdown(facets.value))
const errorCategoryDistribution = computed(() => errorCategoryRows(facets.value))
const errorCategoryUnavailable = computed(() => facetDimensionUnavailable(facets.value, 'error_category'))
/** `reasoning_tokens` 是 Rust 侧**可选列**(cockpit_logs_db.rs 的 optional 列表)。
 *  缺列时 SQL 走 `expr_or(&columns,"reasoning_tokens","0")` ⇒ 聚合值恒 0，
 *  模板若直接渲染就会显示「0 / 0 次请求」，与「实测就是 0」无法区分 —— 正是本组 chip
 *  注释声称要避免的假零。此前另 3 个 chip(error_category / reasoning_effort /
 *  gateway_mode / request_kind)都有守卫，唯此漏(2026-09-20 补齐)。 */
const reasoningTokensUnavailable = computed(() => facetDimensionUnavailable(facets.value, 'reasoning_tokens'))
const reasoningEffortDistribution = computed(() => reasoningEffortRows(facets.value))
const reasoningEffortUnavailable = computed(() => facetDimensionUnavailable(facets.value, 'reasoning_effort'))
const gatewayModeDistribution = computed(() => gatewayModeRows(facets.value))
const gatewayModeUnavailable = computed(() => facetDimensionUnavailable(facets.value, 'gateway_mode'))
const requestKindDistribution = computed(() => requestKindRows(facets.value))
const requestKindUnavailable = computed(() => facetDimensionUnavailable(facets.value, 'request_kind'))

/** 单价对「我们 / 源」。任一侧缺失显示 '—'(不显示 0 —— 0 会被读成"免费")。 */
function pricePair(ours?: number | null, source?: number | null): string {
  const fmt = (v?: number | null) => (v == null ? '—' : cockpitPricePerMillion(v))
  return `${fmt(ours)} / ${fmt(source)}`
}

/** 对账结论 → 徽标样式。只有 match 走成功色,其余都是待核色。 */
function priceStatusClass(status: PriceReconcileStatus): string {
  if (status === 'match') return 'plan-plus'
  if (status === 'no_price_recorded') return 'plan-unknown'
  return 'plan-free'
}

/** 按当前窗口读一次未读维度汇总(失败不阻塞,如实置空)。 */
let facetsRequest = 0
async function loadRequestLogFacets(bounds: { start: Date; end: Date }): Promise<void> {
  const request = ++facetsRequest
  facetsLoaded.value = false
  facets.value = null
  const result = await getRequestLogFacets(bounds.start.getTime(), bounds.end.getTime())
  if (request !== facetsRequest || connectionType.value !== null) return
  facets.value = result
  facetsLoaded.value = true
}

// ── P0-25 多源对账(账本读取层) ──────────────────────────────────────────────
/** 多源对账结果。null = 尚未读取 / 非桌面端。 */
const reconcile = ref<ReconcileResult | null>(null)
/** 账本里的源清单(水位 + 已落库量)。 */
const ledgerSources = ref<LedgerSourceInfo[]>([])
const reconcileLoaded = ref(false)
/** 一句话结论(资产总览页脚注用,永远标注"合并口径待定")。 */
const reconcileSummary = computed(() => describeReconcile(reconcile.value))
/** 对账明细行(天 / 模型 / 两源 / 差额)。 */
const reconcileRows = computed(() => reconcileCellRows(reconcile.value))
/** 只看真正的重叠格(两源都有量)—— 对账最该看的行。 */
const reconcileOverlapRows = computed(() => reconcileRows.value.filter((r) => r.overlap))
/** 结论语气 → 徽标样式。 */
const reconcileTone = computed(() => reconcileVerdictTone(reconcile.value?.verdict ?? 'insufficientData'))
const reconcileVerdictLabel = computed(() =>
  reconcile.value ? RECONCILE_VERDICT_LABELS[reconcile.value.verdict] : t('costCenter.text.notReconciled'),
)

/** P0-15 合并口径结果。null = 尚未读取 / 非桌面端 / 调用失败。 */
const mergedUsage = ref<MergedUsageResult | null>(null)

/** 读一次多源对账 + 源清单 + 合并口径用量(全量窗口:对账要看全部重叠历史,不能被 7d/30d 截断)。 */
async function loadLedgerReconcile(): Promise<void> {
  const [result, sources, merged] = await Promise.all([
    reconcileLedgerSources(null),
    listLedgerSources(),
    mergedLedgerUsage(null),
  ])
  reconcile.value = result
  ledgerSources.value = sources
  mergedUsage.value = merged
  reconcileLoaded.value = true
}

// ── P0-15 合并口径用量(账本读取层,已拍板:按天 × 模型取大) ──────────────────
/** 合并明细行(补可读日期、合计、winner 文案)。 */
const mergedRows = computed<MergedCellRow[]>(() => mergedCellRows(mergedUsage.value))
/**
 * 由**会话源补全**的格(winner 来自 sessions,即日志侧这天漏记/没覆盖)。
 *
 * ⚠️ 这不是"未分档":两源档位同源同规则(摄取层统一 `TokenSplit::add`,阈值 272_000),
 * sessions 侧的量同样带 long 档,成本照常按 ×2/×2/×1.5 计。
 * 这里单列是为了回答"哪天的量是靠会话源补上的"。
 */
const mergedBackfilledRows = computed(() =>
  mergedRows.value.filter((r) => isSessionsWinner(r.winner)),
)
/**
 * 明细行 + 成本。
 *
 * 为什么在这里**一次性**算好而不是在模板里逐行调:模板里调会被求值多次(v-if / 展示各一次),
 * 格数上千时白算一遍。计价仍是同一个入口 `mergedCellCost → cockpitSplitCostUsd`。
 */
const mergedPricedRows = computed(() =>
  mergedRows.value.map((row) => ({
    row,
    cost: mergedCellCost(row, cockpitLocalAccess.value?.modelPricings, data.cockpitCostMultiplier.value),
    // 该格**实测**的长文本文档位占比(不是"有没有分档"的标记);
    // 无 token 时为 null ⇒ UI 显示「—」,不显示 0%
    longRatio: row.totalTokens > 0 ? tierVectorLong(row.tokens) / row.totalTokens : null,
  })),
)
/** 覆盖率文案:「含 N 天由会话源补全(日志侧漏记)」。 */
const mergedCoverageLabel = computed(() => mergeCoverageLabel(mergedUsage.value?.coverage))
/** 长文本文档位占比提示(合并结果实测占比,计价已按 ×2/×2/×1.5 计入)。 */
const mergedLongRatioHint = computed(() => mergeLongRatioHint(mergedUsage.value?.coverage))
/**
 * 合并后的 token 总量(仅用于脚注文案,**不参与任何总额计算**)。
 */
const mergedTotalTokens = computed(() =>
  mergedRows.value.reduce((sum, r) => sum + r.totalTokens, 0),
)

/**
 * 资产总览页脚注:口径**已定案**为「按天 × 模型取大」。
 *
 * ⚠️ 总额**仍走 cockpit 直连口径，本次不切换**。理由(2026-09-12 二次修正):
 * 既不是"未分档"(那是被证伪的错误前提),也不是"总额会跳 +71%"——
 * **+71% 是全量 189 天的数,不适用于本页**:资产总览窗口最长只有 30d
 * (`selectedRangeHours` 里 `30d = 720` 小时),按实际窗口算切换只带来 **+20%**
 * (30d: 16.40B → 19.68B),7d 及更短窗口为 0。
 * 也就是说:切换的收益是修掉 08-22 / 08-23 显示为 0 的明显错误(那两天日志源漏记,
 * 会话源分别有 2.67 亿 / 12.8 亿),代价是重写 `summarize_cockpit_request_logs`
 * 整条聚合链路并作废 §三 逐窗口核对基线。收益对不上成本 ⇒ 暂不切,
 * 完整数据在本页脚注与「API 接入」页的合并面板可查。
 */
const mergeBasisFootnote = computed(() => {
  if (!mergedUsage.value?.available) {
    // 合并层不可用 ⇒ 如实退回"待定",绝不伪造"已定案"
    return reconcileSummary.value
  }
  if ((mergedUsage.value.cells?.length ?? 0) === 0) {
    return t('costCenter.text.mergedBasisReady', { value0: mergedUsage.value.reason ?? t('costCenter.text.noUsageDataInTheLedgerYet') })
  }
  const span = mergedUsage.value.windowStartMs && mergedUsage.value.windowEndMs
    ? t('costCenter.text.coverage', { value0: formatUtcDay(mergedUsage.value.windowStartMs), value1: formatUtcDay(mergedUsage.value.windowEndMs), value2: formatTokens(mergedTotalTokens.value) })
    : `${formatTokens(mergedTotalTokens.value)} token`
  return t('costCenter.text.mergedBasisReadyDailyModelMaximumTotalsStill', { value0: mergedCoverageLabel.value, value1: span })
})

const workspaceItems = computed(() => [
  { key: 'overview' as const, label: t('costCenter.text.assetOverview'), shortcut: '1', icon: Gauge },
  { key: 'upstreams' as const, label: t('costCenter.text.accountRanking'), shortcut: '2', icon: Database },
  { key: 'oauth' as const, label: t('costCenter.text.channelCosts'), shortcut: '3', icon: BarChart3 },
  { key: 'api' as const, label: t('costCenter.text.apiAccess'), shortcut: '4', icon: KeyRound },
  { key: 'unified' as const, label: t('costCenter.text.unifiedSummary'), shortcut: '5', icon: Layers },
])
/** cliproxy 连接专属 tab:5 数据 tab + management iframe tab(自带仪表盘+日志系统)。 */
const cliproxyWorkspaceItems = computed(() => [
  { key: 'overview' as const, label: t('costCenter.text.assetOverview'), shortcut: '1', icon: Gauge },
  { key: 'upstreams' as const, label: t('costCenter.text.accountRanking'), shortcut: '2', icon: Database },
  { key: 'oauth' as const, label: t('costCenter.text.channelCosts'), shortcut: '3', icon: BarChart3 },
  { key: 'api' as const, label: t('costCenter.text.apiAccess'), shortcut: '4', icon: KeyRound },
  { key: 'cliproxy-manage' as const, label: t('costCenter.text.management'), shortcut: '5', icon: Settings2 },
  { key: 'unified' as const, label: t('costCenter.text.unifiedSummary'), shortcut: '6', icon: Layers },
])
/** 按连接类型返回可见 tab 集:sub2api/cockpit 同款 5 tab(资产总览/账号排行/渠道成本/API接入/三端汇总);
 *  cliproxy 复用同款 4 数据 tab + management iframe tab。 */
const visibleWorkspaceItems = computed(() => {
  if (connectionType.value === 'cliproxy') return cliproxyWorkspaceItems.value
  // cockpit(connectionType === null)与 sub2api 共用同款 5 tab,各 tab 内按 connectionType 渲染对应数据
  return workspaceItems.value
})

// 三端汇总:sub2api(复用 accountEconomics) + cockpit(本地 JSON) + cliproxy(token×定价反算)
// 传入倍率 ref:cockpit/cliproxy 官方价成本 × 倍率兜底,与 economics/accountLedgers 同口径
// 传入 sub2api 回退 ref:官方内核无 economics 端点(404)时用窗口 usage_logs actual_cost 聚合兜底。
// 惰性 computed 包一层:windowActualOutputUsd 声明在下方(依赖 data/trend),此处只能延迟读取避免 TDZ。

// cockpit 累计口径的**本项目自算**成本(不含观察窗口,= 库内全量)。
// 2026-09-09: cockpit 的"累计"展示区(账号表/密钥表/模型定价表)此前直接显示数据源自带的
// estimatedCostUsd。本项目已经能按价目表自算(含长上下文档位价),必须统一口径——
// 否则同一份用量在"模型成本表"和"模型定价目录"里出现两个不同的成本数字。
const cockpitCumulativeAccountCost = ref<Record<string, number> | null>(null)
const cockpitCumulativeModelCost = ref<Record<string, number> | null>(null)
const cockpitCumulativeModelBasis = ref<Record<string, CostBasisKind> | null>(null)
const cockpitCumulativeApiKey = ref<Record<string, { requests: number; tokens: number; cost: number | null }> | null>(null)
/** 累计总成本(USD)。单独传一份:库里有少量请求没有 accountId,逐账号求和会漏。 */
const cockpitCumulativeTotalUsd = ref<number | null>(null)
/**
 * 上面那个累计总额的**最差计价依据**(2026-09-23)。
 *
 * `cockpitSplitCostUsd` 在「无本项目单价且源无估算」时返回的是**哨兵 0**(costBasis
 * `no_price_no_estimate`),不是实测成本。若**一部分**模型是这种情形,求和出来的总额只是
 * **下界** —— 只把「全组无单价 ⇒ 总和恰为 0」那半边交给哨兵判定是不够的,
 * 「部分无单价 ⇒ 总额偏小」这半边没有任何信号。取"更差一侧"后透传给三端汇总,
 * 由它把状态如实降成 `partial`(下界),而不是 measured(实测总额)。
 */
const cockpitCumulativeCostBasis = ref<CostBasisKind | null>(null)
/** 逐账号的**最差计价依据**(与上面那份同源、同一条判据)。账号表是**另一个消费点**:
 *  它的合计同样由逐组相加而来,算不出来的组贡献哨兵 0 ⇒ 该账号的金额只是**下界**,
 *  不能渲染成与完全实测一模一样的金额。 */
const cockpitCumulativeAccountBasis = ref<Record<string, CostBasisKind> | null>(null)
/**
 * ★ 数据源**实际覆盖范围**(全表 min/max timestamp),来自累计口径那次全表扫描
 * (`getCockpitRequestLogSummary(1, null, null, false)` 的 `windowStartMs`/`windowEndMs` ——
 * Rust 侧 `start_ms/end_ms` 传 null ⇒ 无时间过滤)。
 *
 * **为什么必须单独存**:2026-09-24 用本机 186,353 行实测核对发现,cockpit 的用量库会**停止写入**
 * (末端停在 `2026-09-17T19:19:54Z`,距今 6.5 天),而面板此前**无条件**标「单请求用量库全程覆盖」。
 * 于是短窗口(1m~24h)的 0 行、7d/30d 的偏小值都被当成了"实测" —— 它们其实是
 * 「**源没覆盖到这段**」。红线:「源不掌握 ≠ 实测为 0」。
 *
 * 这里存**原始区间**而不是算好的状态:状态依赖当前 `range`,存原始值后
 * `range` 变化由下面的 computed 自动重算,不必等一次重新加载。
 */
const cockpitDataSourceRange = ref<{ startMs: number | null; endMs: number | null }>({ startMs: null, endMs: null })
const unified = useUnifiedCost(
  sourceAccountEconomics,
  data.cockpitCostMultiplier,
  computed(() => windowAccountCostUsd.value),
  computed(() => cockpitCumulativeAccountCost.value),
  computed(() => cockpitCumulativeTotalUsd.value),
  computed(() => cockpitCumulativeCostBasis.value),
  computed(() => cockpitCumulativeAccountBasis.value),
)

/** 三端汇总分项格子的 note:无值时只给状态原因;有值时附口径标签。
 *  口径来自 useUnifiedCost,不在这里写死 —— 避免"改一处忘一处"的口径漂移。 */
function unifiedCostNote(status: SourceStatus, unit: CostUnit | null): string {
  if (unit == null) return status.reason
  return t('costCenter.text.basis', { value0: status.reason, value1: unit === 'cumulative' ? t('costCenter.text.cumulative') : t('costCenter.text.window') })
}

/** CLIProxy 估算成本格子的口径 note(2026-09-16 C5)。
 *  useUnifiedCost 已把 basis/label 算好(如"CPA 33 条请求无匹配单价（已按可得单价部分计）"),
 *  但模板零引用 —— 这条诚实标注被静默丢弃。口径说明必须与数值同源,故在此拼接。 */
const cliproxyCostNote = computed(() => {
  const base = unifiedCostNote(unified.sourceStatuses.value.cliproxy, unified.cliproxyCostUnit.value)
  return unified.cliproxyCostLabel.value ? `${base} · ${unified.cliproxyCostLabel.value}` : base
})

/** CLIProxy 匹配请求格子的口径后缀(2026-09-16 C5):
 *  全部/部分请求无匹配单价时,成本是"算不出"或"部分计",必须在这格如实说清。 */
const cliproxyEstimateBasisSuffix = computed(() => {
  const kind = unified.cliproxyEstimate.value?.totalCostBasis.kind
  if (kind === 'no_price_no_estimate') return t('costCenter.text.noMatchingPricesCostUnknownNot0')
  if (kind === 'source_estimate') return t('costCenter.text.someRequestsLackPricesCostIncludesThePriced')
  return ''
})

const distributionColors = ['#b9e55a', '#79b6d9', '#d6aa47', '#d58473', '#8a91bf', '#72a68d', '#b78db7']

/**
 * 账号健康图的数据兜底(2026-09-11 对齐 sub2api-cost-console / api2business)。
 *
 * 参考实现的健康图吃 sub2api `economics.series`;cockpit 源没有这个端点,
 * 于是图一直空着。但"健康三态"本质是失败原因分类,而单请求用量库有
 * `error_category` + `http_status`(实测 upstream_error 19,271 / 限流 730+429 493 /
 * client_canceled 2,761),按桶聚合即可还原——不是没数据,是没去读。
 * 这里只在 sub2api 经济学序列为空、**且当前源就是 cockpit** 时才顶上,不覆盖真实快照。
 */
const adaptiveEconomics = computed<AccountEconomicsSnapshot | null>(() => {
  const base = accountEconomics.value
  if (base?.series?.length) return base
  // 源守卫(2026-09-16):cockpitHealthSeries **只由 cockpit 路径写入**(useCostCenterData
  // loadFromCockpit),而这张健康图渲染在**三源共享**的 overview 面板(:138 起)。
  // 非 cockpit 源下它不属于当前源 —— 一律视为不可用,绝不拿 cockpit 的序列冒充
  // sub2api/cliproxy 的健康数据(否则角标还会把它归因为"从单请求用量库派生",而用户连的不是本机)。
  if (connectionType.value !== null) return base ?? null
  if (!cockpitHealthSeries.value.length) return base ?? null
  return {
    ...(base as AccountEconomicsSnapshot),
    series: cockpitHealthSeries.value,
    events: base?.events ?? [],
  }
})

/** 健康图的状态与口径说明:用了本地派生序列时必须如实标注,不冒充"经济采样"。 */
const healthChartState = computed<{ status: DataAvailability; reason: string }>(() => {
  if (accountEconomics.value?.series?.length) {
    return { status: sourceStates.value.economics.status, reason: sourceStates.value.economics.reason }
  }
  // 源守卫:非 cockpit 源下不得把 cockpit 派生序列的说明挂到当前源的图上。
  if (connectionType.value === null && cockpitHealthSeries.value.length) {
    return {
      status: 'partial',
      reason: t('costCenter.text.derivedByFailureCategoryErrorCategoryHttpStatus'),
    }
  }
  return { status: sourceStates.value.economics.status, reason: sourceStates.value.economics.reason }
})

// ==================== cliproxy 专属面板数据 ====================
const cliproxyOverview = ref<{ version: string | null; authFileCount: number | null; routingStrategy: string | null; debug: boolean | null } | null>(null)
const cliproxyAuthFileFailure = ref<{ detail: string } | null>(null)
const cliproxyAuthFileError = computed(() => cliproxyAuthFileFailure.value == null ? '' : cliproxyAuthFileFailure.value.detail || t('costCenter.text.failedToReadCurrentCredentialInventory'))
/**
 * E2:cliproxy 业务端点 baseUrl 只来自当前激活连接。
 * 8317 是 cliproxy 的默认端口,不是用户配过的事实 —— 缺失时返回空串,
 * 让 truthfulState 走 unavailable(此前 `|| 'http://127.0.0.1:8317'` 使值恒非空,
 * 再配字面量 state="measured",等于替用户声称一份他没配过的地址)。
 */
const cliproxyBusinessBase = computed(() => connectionStore.active?.baseUrl?.replace(/\/+$/, '') || '')
/** 业务端点完整地址:baseUrl 未知时整格渲染 —,不拼出一条用户没配过的地址。 */
function cliproxyEndpoint(path: string): string {
  return cliproxyBusinessBase.value ? `${cliproxyBusinessBase.value}${path}` : UNKNOWN_DASH
}
const cliproxyManageFrame = ref<HTMLIFrameElement | null>(null)
const cliproxyManageUrl = computed(() => {
  const base = connectionStore.active?.baseUrl?.trim().replace(/\/+$/, '')
  return base ? `${base}/management.html` : 'http://127.0.0.1:8317/management.html'
})
/** 未配置 baseUrl 时 iframe 走 CPA 默认端口 8317 —— 这是**假设的默认值**,不是用户配过的地址。
 *  管理 iframe 是便利入口(猜错用户立刻看得见:页面加载不出来),所以保留 8317 不牺牲功能;
 *  但绝不静默使用:未配置时在 iframe 上方显式标注这是默认值假设。
 *  (数据端点 cliproxyBusinessBase / cliproxyEndpoint 的 8317 兜底已移除,那是另一回事 —— 数据端点猜错
 *   会静默指向错的东西,不会有任何可见反馈。) */
const cliproxyManageUsesDefaultPort = computed(() => !connectionStore.active?.baseUrl?.trim())

/** iframe 加载后注入 secret-key 到 management.html 的 localStorage(managementKey + rememberPassword)。
 *  跨域时 contentWindow.localStorage 不可写(SecurityError)静默失败——management.html 与桌面端 dev 不同源时
 *  无法自动注入,用户首次手动输 secret-key 勾选记住后,WebView2 同源窗口共享 localStorage,后续自动登录。 */
function injectCliproxyManagementKey() {
  const secretKey = connectionStore.active?.secretKey
  if (!secretKey || !cliproxyManageFrame.value?.contentWindow) return
  try {
    const w = cliproxyManageFrame.value.contentWindow
    w.localStorage.setItem('managementKey', secretKey)
    w.localStorage.setItem('rememberPassword', 'true')
  } catch { /* 跨域 SecurityError,静默降级 */ }
}

// loadCliproxyOverview 已合并到 reload 的 cliproxy 分支(单次并行请求,消除重复 getAuthFiles/getDebug/getRoutingStrategy)

// ==================== cockpit 专属面板数据(5 类本地 JSON 一次性加载) ====================
const cockpitStats = ref<CockpitStats | null>(null)
const cockpitCodexAccounts = ref<CockpitCodexAccount[]>([])
const cockpitGeminiAccounts = ref<CockpitGeminiAccount[]>([])
const cockpitAntigravityAccounts = ref<CockpitAntigravityAccount[]>([])
const cockpitLocalAccess = ref<CockpitLocalAccess | null>(null)
const cockpitClaudeAccounts = ref<CockpitPlatformAccount[]>([])
const cockpitCursorAccounts = ref<CockpitPlatformAccount[]>([])
const cockpitKiroAccounts = ref<CockpitPlatformAccount[]>([])
const cockpitModelProviders = ref<CockpitModelProvider[]>([])
/** cockpit 账号分组映射(accountId → 分组名)。来自 account_groups.json / codex_account_groups.json。
 *  cockpit 的 request_logs 来源没有分组记录,但账号分组可从分组文件反查 → 路由表「分组」列据此回填。 */
const cockpitGroupNameMap = ref<Map<string, string>>(new Map())
// cockpit 配额历史 + 路由日志(第三轮新增,供 loadFromCockpit 填 accountUsage/modelRoutes)
const cockpitQuotaHistories = ref<CockpitQuotaHistoryFile[]>([])
const cockpitApiLog = ref<string | null>(null)
/** 本地持久账本(cost_ledger.sqlite)最近一次摄取结果。null = 尚未触发/非桌面端。
 *  账本的存在意义:cockpit 会轮转/重建自己的库,不落一份持久账本历史就丢了。 */
const ledgerIngestState = ref<LedgerIngestResult | null>(null)
const ledgerIngestLabel = computed(() => describeLedgerIngest(ledgerIngestState.value))
/** 至少有一个源"真的把数据拿进来了"(可用、非让路、无硬错误)→ 状态条走成功色。 */
const ledgerIngestDelivered = computed(() =>
  (ledgerIngestState.value?.sources ?? []).some((s) => ledgerSourceDelivered(s)),
)
/** 多天日志聚合实际读到的日志日期范围(7d/30d 时由 summarize_cockpit_api_logs 返回)。
 *  cockpit 日志按天滚动且受保留期限制,30d 窗口可能只有几天日志——
 *  请求数列据此如实标注覆盖范围,少计的时段不冒充完整窗口。 */
const cockpitLogWindowRange = ref<{ min: string; max: string } | null>(null)
// API 接入派生
/** 网关地址:port 只来自 codex_local_access.json。49179 是 cockpit 自己的默认端口,
 *  不是用户配过的事实 —— 与「源文件不存在时绝不套用 cockpit 源码默认值」的既有约定一致。
 *  缺失时返回 —,让 truthfulState 走 unavailable(此前值恒非空 → 该格恒为 measured,等于没改)。 */
const cockpitGatewayUrl = computed(() => {
  const port = cockpitLocalAccess.value?.port
  return port ? `http://127.0.0.1:${port}` : '—'
})
function maskCockpitKey(key: string | undefined): string {
  if (!key) return '—'
  if (key.length <= 12) return key.slice(0, 4) + '…'
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}
function cockpitPricePerMillion(value: number | null | undefined): string {
  // modelPricings 字段已是每百万 Token 单价,直接显示,不二次换算
  return value == null || !Number.isFinite(Number(value)) ? '—' : `$${Number(value).toFixed(2)}/M`
}

// ==================== 账号导入 ====================
const importing = ref(false)
const importResult = ref<CockpitImportResult | null>(null)

/** 处理 JSON 文件导入:支持两种格式
 *  1. { accounts: [...] } — codex 账号列表,导入到 codex_accounts.json
 *  2. { customRoutingRules: [...] } — 路由规则,导入到 codex_local_access.json
 *  3. 同时包含 accounts + customRoutingRules — 两者都导入 */
async function handleImportFile(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return
  importing.value = true
  importResult.value = null
  try {
    const text = await file.text()
    const data = JSON.parse(text)
    const messages: CockpitImportResult[] = []
    let totalAdded = 0
    let totalSkipped = 0
    // 导入 codex 账号
    if (Array.isArray(data.accounts)) {
      const accounts = data.accounts.filter((a: Record<string, unknown>) => a && typeof a.id === 'string')
      if (accounts.length > 0) {
        const result = await importCockpitCodexAccounts(accounts)
        messages.push(result)
        totalAdded += result.added
        totalSkipped += result.skipped
      }
    }
    // 导入路由规则
    if (Array.isArray(data.customRoutingRules)) {
      const rules = data.customRoutingRules.filter((r: Record<string, unknown>) => r && typeof r.accountId === 'string')
      if (rules.length > 0) {
        const result = await importCockpitRoutingRules(rules)
        messages.push(result)
        totalAdded += result.added
        totalSkipped += result.skipped
      }
    }
    if (messages.length === 0) {
      importResult.value = { added: 0, skipped: 0, total: 0, get message() { return t('costCenter.text.noImportableAccountsOrRoutingRulesFoundAccounts') } }
    } else {
      importResult.value = { added: totalAdded, skipped: totalSkipped, total: 0, get message() { return messages.map(result => result.message).join(' · ') } }
    }
    // 导入后重新加载 cockpit 数据
    await loadCockpitOverview()
    await reload()
  } catch (e) {
    const detail = errMsg(e, '')
    importResult.value = { added: 0, skipped: 0, total: 0, get message() { return t('costCenter.text.importFailed', { value0: detail || t('costCenter.text.unknownError') }) } }
  } finally {
    importing.value = false
    // 重置 file input 以便可以再次选择同一文件
    target.value = ''
  }
}

async function loadCockpitOverview() {
  if (connectionType.value !== null) return
  try {
    const [stats, codex, gemini, antigravity, localAccess, claude, cursor, kiro, providers, codexGroups, accountGroups] = await Promise.all([
      getCockpitStats(),
      getCockpitCodexAccounts(),
      getCockpitGeminiAccounts(),
      getCockpitAntigravityAccounts(),
      getCockpitLocalAccess(),
      getCockpitPlatformAccounts('claude_accounts.json'),
      getCockpitPlatformAccounts('cursor_accounts.json'),
      getCockpitPlatformAccounts('kiro_accounts.json'),
      getCockpitModelProviders(),
      // 账号分组(cockpit 把分组存在 JSON 文件里,不是 SQLite 表):accountId → 分组名
      getCockpitCodexAccountGroups(),
      getCockpitAccountGroups(),
    ])
    cockpitStats.value = stats
    cockpitCodexAccounts.value = codex
    cockpitGeminiAccounts.value = gemini
    cockpitAntigravityAccounts.value = antigravity
    cockpitLocalAccess.value = localAccess
    cockpitClaudeAccounts.value = claude
    cockpitCursorAccounts.value = cursor
    cockpitKiroAccounts.value = kiro
    cockpitModelProviders.value = providers
    cockpitGroupNameMap.value = cockpitGroupNameByAccountId(codexGroups, accountGroups)
  } catch (e) {
    console.warn('[cockpit] overview load failed', errMsg(e, ''))
  }
}

const activePanel = ref<WorkspaceKey>(normalizePanel(route.query.panel))
const range = ref<CostCenterRange>(DEFAULT_COST_CENTER_RANGE)
const platformFilter = ref<UpstreamProviderFilter>('all')
const rankingMetric = ref<RankingMetric>('score')
const poolPlatform = ref<UpstreamProviderFilter>('all')
const searchQuery = ref('')
/**
 * 是否显示"历史孤儿账号"。
 *
 * 实测(2026-09-04 真实 cockpit 数据):codex_local_access_stats.json 累计 222 个账号,
 * 但 codex_accounts.json 当前只剩 7 个——其余 215 个是已被移除的账号,stats 只保留其历史累计。
 * 这些孤儿无 plan/无配额/无今日用量,混在主表会造成:
 * 状态全显示 active(不真实)、调度评分全落默认值、用量窗口空、各成本列为 0。
 * 默认隐藏,让用户先看到真实号池;需要查历史累计时再手动打开。
 */
const showHistoricalAccounts = ref(false)
const selectedAccount = ref<Account | null>(null)
const selectedAccountIds = ref<Set<CostAccountId>>(new Set())
const bulkCostEdit = ref(false)
const modelWindowReadFailed = ref(false)
let modelWindowGeneration = 0
const now = ref(new Date())
const autoRefresh = ref(true)
const refreshIntervalSeconds = ref<5 | 10 | 15 | 30>(30)
const countdown = ref<number>(refreshIntervalSeconds.value)
const refreshing = ref(false)
const autoRefreshLabel = computed(() => !autoRefresh.value ? t('costCenter.text.autoRefresh') : refreshing.value || loading.value ? t('costCenter.text.refreshing') : `${Math.max(0, countdown.value)}s`)
let clockTimer: number | null = null

const isTauriDesktop = '__TAURI_INTERNALS__' in (window as any)
const desktopMode = computed(() => route.query.desktop === '1' || isTauriDesktop)
/** 当前活跃连接类型:决定主体面板是否可用 sub2api 端点 + cliproxy 默认进三端汇总 */
const connectionType = computed(() => connectionStore.active?.type ?? null)
watch(connectionType, type => {
  showHistoricalAccounts.value = type === 'cliproxy'
  modelWindowGeneration += 1
  modelWindowReadFailed.value = false
}, { immediate: true })
/** 三源标识(给按源分支的子组件用:AdaptiveOperationsCharts / DataGovernancePanel)。
 *  必须三态穷举 —— cockpit 正是 `connectionType === null` 的那一端,写成 `A ? x : y`
 *  会把 cockpit 静默当成 sub2api(措辞守卫 cliproxyWordingContract.spec.ts 会抓)。
 *  不在模板里写嵌套三元:同一条派生逻辑散在多处必然改一处漏一处。 */
const costSourceKind = computed<'sub2api' | 'cliproxy' | 'cockpit'>(() => {
  if (connectionType.value === 'sub2api') return 'sub2api'
  if (connectionType.value === 'cliproxy') return 'cliproxy'
  return 'cockpit'
})
const financeInstanceId = computed(() => connectionType.value === 'sub2api' ? connectionStore.active!.id : 'local')
const operatingScope = computed(() => ({ source: costSourceKind.value, instanceId: financeInstanceId.value }))
const operatingUsageReady = computed(() => {
  const scope = data.rangeAccountStatsScope.value
  const window = data.rangeAccountStatsWindow.value
  return scope?.source === operatingScope.value.source && scope.instanceId === operatingScope.value.instanceId
    && window != null && window.start.getTime() === usageWindowBounds(range.value, window.end).start.getTime()
    && hasMeasuredData(sourceStates.value.rangeStats)
})
const financeInitialAnchor = new Date()
const financeWindow = computed(() => {
  if (operatingUsageReady.value) return data.rangeAccountStatsWindow.value!
  const anchor = lastUpdated.value ?? financeInitialAnchor
  const bounds = usageWindowBounds(range.value, anchor)
  return { start: bounds.start, end: new Date(Math.min(bounds.end.getTime(), anchor.getTime())) }
})
const financeAccounts = computed(() => accounts.value.map(account => ({ id: String(account.id), name: account.name })))
const financeSnapshot = ref<FinanceSnapshot | null>(null)
const financeError = ref('')
const financePending = ref(false)
const financeLoadedKey = ref('')
const financeQueryKey = computed(() => `${costSourceKind.value}|${financeInstanceId.value}|${financeWindow.value.start.getTime()}|${financeWindow.value.end.getTime()}`)
let financeSequence = 0
async function loadLocalFinance() {
  if (!isTauriDesktop) return
  const sequence = ++financeSequence
  financeSnapshot.value = null
  financeLoadedKey.value = ''
  financePending.value = true
  financeError.value = ''
  try {
    const key = financeQueryKey.value
    const result = await getFinanceLedger({ source: costSourceKind.value, instanceId: financeInstanceId.value, startMs: financeWindow.value.start.getTime(), endMs: financeWindow.value.end.getTime() })
    if (sequence === financeSequence && key === financeQueryKey.value) { financeSnapshot.value = result; financeLoadedKey.value = key }
  } catch (failure) {
    if (sequence === financeSequence) financeError.value = failure instanceof Error ? failure.message : String(failure)
  } finally { if (sequence === financeSequence) financePending.value = false }
}
watch(financeQueryKey, loadLocalFinance, { immediate: true })
/** 顶部品牌眉标:按数据端显示对应名称(sub2api/CLIProxy/Cockpit),非固定 SUB2API。 */
const brandEyebrow = computed(() => {
  if (connectionType.value === 'sub2api') return t('costCenter.text.sub2apiCostCenter')
  if (connectionType.value === 'cliproxy') return t('costCenter.text.cliproxyapiCostCenter')
  return t('costCenter.text.cockpitLocalData')
})

function openAccountPurchase() {
  openProjectExternalUrl(ACCOUNT_PURCHASE_URL).catch((reason) => {
    error.value = reason instanceof Error ? reason.message : String(reason)
  })
}
/** 桌面端返回连接界面 */
function goBackToConnect() {
  router.push('/connect')
}
const panelTitle = computed(() => {
  const p = activePanel.value
  if (p === 'overview') return t('costCenter.text.upstreamAssetsLiveCosts')
  if (p === 'upstreams') return t('costCenter.text.accountOperations')
  if (p === 'oauth') return t('costCenter.text.oauthLiveCosts')
  if (p === 'unified') return t('costCenter.text.unifiedCostSummary')
  if (p === 'cliproxy-manage') return t('costCenter.text.cliproxyManagement')
  if (p === 'api') return t('costCenter.text.apiAccessCenter')
  if (p === 'governance') return t('costCenter.text.dataSourcesAndHistoryControls')
  if (p === 'finance') return t('costCenter.text.costLedger')
  return t('costCenter.text.costCenter')
})
const panelDescription = computed(() => activePanel.value === 'overview' ? (connectionType.value === null ? t('costCenter.text.scoresSchedulingProcurementAndCalculatedApiCosts') : connectionType.value === 'cliproxy' ? t('costCenter.text.scoresSchedulingProcurementAndEstimatedApiCosts') : t('costCenter.text.scoresSchedulingProcurementAndApiOutput')) : activePanel.value === 'upstreams' ? t('costCenter.text.accountHealthAndCostOperations') : activePanel.value === 'oauth' ? t('costCenter.text.accountPoolEconomicsFromEachAccountSStart') : activePanel.value === 'governance' ? t('costCenter.text.sourceHealthTimeBoundariesRetentionAndMaintenance') : activePanel.value === 'unified' ? t('costCenter.text.sub2apiCliproxyCockpitCostSummarySelectedSourcesOnly') : t('costCenter.text.localGatewayAgentConfigurationAndLatencyDiagnostics'))
// 窗口中文名单一来源(usageWindow.costCenterRangeLabel),store 状态文案与此处共用同一映射
const rangeLabel = computed(() => costCenterRangeLabel(range.value))
/** 资产总览口径标签:数据源 + 当前统计时间(cockpit 附真实累计窗口)。
 *  数字对不上时先看清"哪个源、哪个窗口",避免把 cockpit 日历累计当成滚动窗口去比。 */
const assetScopeLabel = computed(() => {
  const source = connectionType.value === 'sub2api'
    ? t('costCenter.text.remoteSub2api')
    : connectionType.value === 'cliproxy'
      ? 'CLIProxyAPI'
      : t('costCenter.text.localCockpit')
  return connectionType.value === null && cockpitWindowLabel.value
    ? `${source} · ${cockpitWindowLabel.value}`
    : `${source} · ${rangeLabel.value}`
})
/** 路由明细表口径说明:cockpit 无 usage_logs(日志也无逐请求 token),必须如实区分,
 *  否则"只展示 usage_logs 实际记录"在 cockpit 下是假话;cliproxy 同理(路由由 CPA usage_events 派生)。
 *  另注:「分组」列在 cockpit 下取自 cockpit 账号分组文件(account_groups.json /
 *  codex_account_groups.json),不是 sub2api 计费分组——两套同名不同义,需明示。 */
/** 路由明细表口径说明:**截断态** 与 **源三态** 合在**一个**出口。
 *  ★ 2026-09-26 审核:此前「源口径说明」与「截断说明」是两条并列的 `<small>`,而它们互斥 ——
 *    截断成立时数据是**最近样本**而不是所选窗口,此时上一句仍在宣称「按所选窗口聚合」,
 *    两句同时出现在屏幕上就是自相矛盾。⇒ 截断成立时**取代**窗口声明(不许并列)。
 *  ★ 截断上限与数据面按源三态穷举:cockpit = 当天日志行数上限,cliproxy = CPA 事件读取上限,
 *    sub2api = usage_logs 分页上限。上限数字一律引常量,不在 UI 里另抄一份。 */
const routeTableHint = computed(() => {
  if (modelRoutesTruncated.value) {
    return connectionType.value === null
      ? t('costCenter.text.todaySLogsExceedTheRowLimitRecent', { value0: MAX_COCKPIT_LOG_LINES })
      : connectionType.value === 'cliproxy'
        ? t('costCenter.text.cpaUsageEventsExceedTheReadLimitRecent')
        : t('costCenter.text.windowExceedsUsageLogsRecentSamplesOnlyNot', { value0: USAGE_LOGS_SAFE_READ_CAP })
  }
  return connectionType.value === null
    ? t('costCenter.text.aggregatesCodexApiLogOverTheSelectedWindow')
    : connectionType.value === 'cliproxy'
      ? t('costCenter.text.simplifiedRoutesDerivedFromCpaUsageEventsBy')
      : t('costCenter.text.showsOnlyActualUsageLogsRecordsDoesNot')
})
/** 模型区当前生效的窗口标签(双轨:未分离时 = 顶部主窗口,分离时 = 模型区自己的选择)。 */
const modelCostRangeLabel = computed(() => costCenterRangeLabel(modelCostRange.value))
// 初始跟随主窗口(用户手动改模型区窗口后才分离)
modelCostRange.value = range.value
const modelCostSourceLabel = computed(() => ({
  requested: t('costCenter.text.userRequestedModel'),
  upstream: t('costCenter.text.modelSentUpstream'),
  response: t('costCenter.text.modelDeclaredInUpstreamResponseCostStillUses'),
  mapping: t('costCenter.text.requestedForwardedModelMapping'),
})[modelCostSource.value])
/** 模型面板副标题的核算口径:三源各不相同,不能统一宣称"渠道价格与账号费率"。
 *  cliproxy 无渠道价与账号费率(CPA 只回 usage 事件,成本按 目录/本地参考价估算);
 *  cockpit 无渠道价(本地价目表自算)。 */
const modelCostBasisNote = computed(() => connectionType.value === null
  ? t('costCenter.text.calculatedFromRecordedUsageTokensActualModelsAnd')
  : connectionType.value === 'cliproxy'
    ? t('costCenter.text.estimatedFromRecordedUsageTokensActualModelsAnd')
    : t('costCenter.text.calculatedSeparatelyUsingRecordedUsageTokensActualModels'))
/** 模型表营收缺失说明:cliproxy 修成 actual_cost=null 后 revenueMissing 才为 true,
 *  此时不能再沿用 cockpit 专属的"本机"措辞(CPA 不是本机采集源)。 */
const revenueMissingNote = computed(() => connectionType.value === 'cliproxy'
  ? t('costCenter.text.cpaHasNoRevenueBasis')
  : connectionType.value === null
    ? t('costCenter.text.localUsageHasNoRevenueBasis')
    : t('costCenter.text.sourceDoesNotProvideActualCost'))
const lastUpdatedLabel = computed(() => lastUpdated.value ? formatDateByLocale(lastUpdated.value, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : t('costCenter.text.waitingForFirstRefresh'))
const modelCostRows = computed(() => buildModelCostRows(models.value))
const modelCostSummary = computed(() => summarizeModelCosts(modelCostRows.value))
const visibleModelRoutes = computed(() => modelAuditMismatchOnly.value
  ? modelRoutes.value.filter((row) => row.modelAuditStatus === 'mismatch')
  : modelRoutes.value)
const routeColumnCount = 12
const localCatalog = ref<ModelCatalogStatus | null>(null)
const localCatalogBusy = ref(false)
const localCatalogError = ref('')
async function loadLocalCatalog(sync = false) {
  if (!isTauriDesktop || connectionType.value === 'sub2api' || localCatalogBusy.value) return
  localCatalogBusy.value = true
  try {
    localCatalog.value = await (sync ? refreshModelCatalog() : getModelCatalogStatus())
    localCatalogError.value = localCatalog.value.error ?? ''
  } catch (e) { localCatalogError.value = e instanceof Error ? e.message : String(e) }
  finally { localCatalogBusy.value = false }
}
const pricingCatalogLabel = computed(() => {
  if (connectionType.value !== 'sub2api') {
    if (localCatalog.value?.available) return t('costCenter.text.modelsDevModelProviderPrices', { value0: formatInteger(localCatalog.value.modelCount) })
    const count = Object.keys(modelPricing.value).length
    return count ? t('costCenter.text.catalogLocalReferencesModels', { value0: formatInteger(count) }) : t('costCenter.text.noUsablePriceCatalogYet')
  }
  if (!pricingStatus.value) return t('costCenter.text.statusUnavailable')
  const synchronized = pricingStatus.value.catalog_source !== ''
    && pricingStatus.value.catalog_source === pricingStatus.value.configured_source
  return t('costCenter.text.models', { value0: formatInteger(pricingStatus.value.model_count), value1: synchronized ? t('costCenter.text.cacheSynchronized') : t('costCenter.text.awaitingSynchronization') })
})
const pricingCatalogDetail = computed(() => {
  if (connectionType.value !== 'sub2api') {
    const updated = localCatalog.value?.fetchedAtMs
    return t('costCenter.text.updatedEvery24HoursCacheRetainedOnFailure', { value0: updated ? new Date(updated).toLocaleString(getLocale()) : t('costCenter.text.modelsDevNotYetSynchronized'), value1: localCatalogError.value ? ` · ${localCatalogError.value}` : '' })
  }
  if (!pricingStatus.value) return t('costCenter.text.currentBackendDoesNotExposePriceCatalogStatus')
  const updated = new Date(pricingStatus.value.last_updated)
  const updatedLabel = Number.isFinite(updated.getTime()) ? updated.toLocaleString(getLocale()) : t('costCenter.text.updateTimeUnknown')
  let source = pricingStatus.value.catalog_source || pricingStatus.value.configured_source || t('costCenter.text.remoteCatalogNotConfigured')
  try { source = new URL(source).hostname } catch { /* keep the configured label */ }
  return t('costCenter.text.autoSyncEveryHours', { value0: updatedLabel, value1: source, value2: pricingStatus.value.update_interval_hours || 24, value3: pricingStatus.value.fallback_available ? t('costCenter.text.offlineFallbackLoaded') : t('costCenter.text.offlineFallbackMissing') })
})
const modelCostAccountSelection = computed({
  get: () => modelCostAccountId.value == null ? 'all' : String(modelCostAccountId.value),
  set: (value: string) => {
    modelCostAccountId.value = value === 'all' ? null : accounts.value.find(account => String(account.id) === value)?.id ?? null
  },
})
const modelCostAccountLabel = computed(() => {
  if (modelCostAccountId.value == null) return t('costCenter.text.allAccountsCombined')
  const account = accounts.value.find((item) => item.id === modelCostAccountId.value)
  return account ? `${account.name} · ${accountOriginLabel(account)}` : t('costCenter.text.account', { value0: modelCostAccountId.value })
})
/**
 * 模型成本表空态文案(2026-09-13 修「成本账号」选择器空转的配套):
 * cockpit 源下若已按账号筛选,必须如实说明是"该账号在此窗口无记录",
 * 不能笼统说"没有可分析的模型调用"——那会让人误以为整个窗口都没数据。
 */
const modelCostEmptyLabel = computed(() => {
  if (sourceStates.value.models.status === 'unavailable') return t('costCenter.text.modelCostsUnavailable', { value0: sourceStates.value.models.reason })
  if (connectionType.value === null && modelCostAccountId.value != null) {
    return t('costCenter.text.noModelCallsForIn', { value0: modelCostRangeLabel.value, value1: modelCostAccountLabel.value })
  }
  return t('costCenter.text.noModelCallsToAnalyzeIn', { value0: modelCostRangeLabel.value })
})
const modelRouteEmptyLabel = computed(() => {
  if (sourceStates.value.modelRoutes.status === 'unavailable') return t('costCenter.text.modelRoutesUnavailable', { value0: sourceStates.value.modelRoutes.reason })
  if (modelAuditMismatchOnly.value) return t('costCenter.text.noConfirmedModelMismatchesIn', { value0: modelCostRangeLabel.value })
  if (connectionType.value === null && modelCostAccountId.value != null) {
    return t('costCenter.text.noRouteRecordsForIn', { value0: modelCostRangeLabel.value, value1: modelCostAccountLabel.value })
  }
  return t('costCenter.text.noRecordedRoutesIn', { value0: modelCostRangeLabel.value })
})

function currentAccountState(account: Account) {
  return describeCurrentAccountState(account, probes.value[String(account.id)], now.value)
}

function accountOriginLabel(account: Account): string {
  return account.extra?.cliproxy_identity_source === 'usage_only'
    ? t('costCenter.text.usageIdentity', { value0: resolveAccountBillingMode(account) === 'unknown' ? t('costCenter.text.billingTypeUnknown') : describeCostAccountOrigin(account) })
    : resolveAccountBillingMode(account) === 'unknown' ? t('costCenter.text.billingTypeUnknown') : describeCostAccountOrigin(account)
}
function isCurrentAccount(account: Account): boolean {
  return account.extra?.cockpit_historical !== true && (connectionType.value !== 'cliproxy' || account.extra?.cliproxy_identity_source === 'management')
}
const currentAccounts = computed(() => accounts.value.filter(isCurrentAccount))
const currentAccountsReady = computed(() => (hasMeasuredData(sourceStates.value.accounts) || connectionType.value === 'cliproxy' && sourceStates.value.accounts.status === 'stale' && data.cliproxyManagementSnapshotAt.value != null)
  && (connectionType.value !== 'cliproxy' || data.cliproxyLocalAccountLink.value && cliproxyOverview.value?.authFileCount != null))
const activeAccounts = computed(() => currentAccounts.value.filter((account) => currentAccountState(account).state === 'normal'))
const currentAccountHealth = computed(() => {
  if (!currentAccountsReady.value) return null
  const counts = { normal: 0, limited: 0, error: 0, inactive: 0 }
  for (const row of accountLedgers.value) {
    if (!row.isHistorical && isCurrentAccount(row.account)) counts[currentAccountState(row.account).state] += 1
  }
  return counts
})
const currentAccountHealthReason = computed(() => {
  if (connectionType.value === 'cliproxy' && sourceStates.value.accounts.status === 'stale') return t('costCenter.text.lastSuccessfulCredentialSnapshot', { value0: data.cliproxyManagementSnapshotAt.value ?? t('costCenter.text.timeUnknown'), value1: sourceStates.value.accounts.reason, value2: cliproxyAuthFileError.value ? t('costCenter.text.label', { value0: cliproxyAuthFileError.value }) : '' })
  if (accountEconomics.value?.series?.length || connectionType.value === null && cockpitHealthSeries.value.length) return healthChartState.value.reason
  if (connectionType.value === 'cliproxy' && !data.cliproxyLocalAccountLink.value) return t('costCenter.text.currentConnectionHasNoAssociatedLocalCredentialsHistorical')
  if (connectionType.value === 'cliproxy' && cliproxyOverview.value?.authFileCount == null) return cliproxyAuthFileError.value || t('costCenter.text.currentCredentialInventoryUnavailableHistoricalUsageCannotEstablish')
  return healthChartState.value.reason
})
const upstreamProviderTabs = computed(() => buildUpstreamProviderTabs(accounts.value))
const activitySourceState = computed<DataSourceState>(() => opsOverview.value ? sourceStates.value.ops : sourceStates.value.dashboard)
/**
 * 请求计数 / 失败率(审查 #6)。
 * Ops 在 requestTotal === 0 时硬编码 `error_rate: 0`(见 cliproxyAdapter),
 * 直接渲染就变成"实测失败率 0.0%" —— 那是把"零观测"说成"零失败"。
 * 统一走 resolveRequestCounts:分母为 0 ⇒ null ⇒ 界面显示 `—`。
 */
const requestCounts = computed(() => resolveRequestCounts({
  reportedTotal: opsOverview.value?.request_count_total,
  reportedSuccess: opsOverview.value?.success_count,
  reportedError: opsOverview.value?.error_count_total,
  reportedErrorRate: opsOverview.value?.error_rate,
  fallbackTotal: trend.value.reduce((sum, point) => sum + Number(point.requests || 0), 0),
  // 只有趋势点真的存在,累加值才算"观测到";一个点都没有 = 零观测,不是 0 次。
  fallbackObserved: trend.value.length > 0,
}))
const totalObservedRequests = computed(() => requestCounts.value.total)
const successCount = computed(() => requestCounts.value.success)
const errorCount = computed(() => requestCounts.value.error)
const errorRate = computed(() => requestCounts.value.errorRate)
const requestFailureNote = computed(() => {
  if (!opsOverview.value) return sourceStates.value.ops.reason || t('costCenter.text.operationsMonitoringDisabledNoStatusInferred')
  const rate = requestCounts.value.reportedErrorRate
  const sourceNote = rate != null && (errorRate.value == null || Math.abs(rate - errorRate.value) > 0.00005)
    ? t('costCenter.text.source', { value0: connectionType.value === 'sub2api' ? t('costCenter.text.slaErrorRate') : t('costCenter.text.reportedRatio'), value1: formatPercent(rate), value2: connectionType.value === 'sub2api' ? t('costCenter.text.excludesBusinessRestrictionsSeparateBasis') : t('costCenter.text.separateBasis') }) : ''
  return t('costCenter.text.allFailureRatio', { value0: formatPercentOrDash(errorRate.value), value1: formatInteger(errorCount.value), value2: formatInteger(totalObservedRequests.value), value3: sourceNote })
})
/**
 * FIX 2:切号事件 —— 只有**真的采集到切号点**的源才允许显示数字。
 * - sub2api 的 ops 点带 switch_count(0 是合法实测值,必须仍算作 0,不能判成 null)
 * - cockpit 日志没有切号字段(适配器三处 switch_count: 0 是假零,已改 null)
 * - cliproxy 的 cliproxyEventsToOps 根本不带该键(Number(undefined || 0) 也是 0)
 * 一个有限数值点都没有 ⇒ null ⇒ 界面显示「无数据」,绝不显示 0 并声称"真实切号已采集"。
 */
const switchCount = computed<number | null>(() => {
  let sum = 0
  let observed = false
  for (const point of opsTrend.value) {
    if (point.switch_count == null) continue
    const value = Number(point.switch_count)
    if (!Number.isFinite(value)) continue
    sum += value
    observed = true
  }
  return observed ? sum : null
})
/** 首 token P95(审查 #1):无样本返回 null,绝不返回 0 —— `0 ms` 是"瞬时返回"的断言。 */
const ttftP95 = computed(() => latencySampleMs(opsOverview.value?.ttft?.p95_ms))
/**
 * 综合质量分(审查 #7):连同**真实来源**一起返回。
 * 此前只凭 opsOverview 是否存在就标「Ops 实测」,可 health_score 为 null 时分数是账号状态推算的。
 */
const quality = computed(() => resolveQualityScore({
  healthScore: opsOverview.value?.health_score,
  activeAccounts: activeAccounts.value.length,
  totalAccounts: currentAccountsReady.value ? currentAccounts.value.length : 0,
  errorRate: errorRate.value,
}))
const qualityScore = computed(() => quality.value.score)
const qualityProvenance = computed(() => quality.value.provenance)
const qualityGrade = computed(() => qualityScore.value == null ? UNKNOWN_DASH : scoreGrade(qualityScore.value))
/** 分数标注:Ops 实测 / 账号状态推算 —— 与数值的真实来源一致,不冒充实测。 */
const qualityProvenanceLabel = computed(() => qualityProvenance.value === 'ops' ? t('costCenter.text.opsMeasured') : t('costCenter.text.inferredFromAccountStatus'))
const schedulerBaseScoreMax = computed(() => resolveSchedulerBaseScoreMax(systemSettings.value as Record<string, unknown> | null))

const latestCostLossByAccount = computed(() => {
  const states = new Map<string, typeof costLossStates.value[number]>()
  for (const state of costLossStates.value) {
    const previous = states.get(String(state.account_id))
    if (!previous || new Date(state.occurred_at).getTime() > new Date(previous.occurred_at).getTime()) {
      states.set(String(state.account_id), state)
    }
  }
  return states
})

const financialCosts = computed(() => {
  const records = new Map<string, NonNullable<FinanceSnapshot['byAccount']>>()
  for (const record of financeLoadedKey.value === financeQueryKey.value ? financeSnapshot.value?.byAccount ?? [] : []) {
    const rows = records.get(record.accountId) ?? []
    rows.push(record)
    records.set(record.accountId, rows)
  }
  const current = new Map(accounts.value.map(account => [String(account.id), account]))
  const losses = new Map([...latestCostLossByAccount.value].map(([id, loss]) => [String(id), loss]))
  const ids = new Set([...current.keys(), ...records.keys(), ...losses.keys(), ...Object.keys(operatingUsageReady.value ? data.rangeAccountStats.value : {})])
  return new Map([...ids].map(id => {
    const account = current.get(id)
    const loss = losses.get(id)
    const profile = account ? resolveFallbackCostProfile(account, cockpitCostMultiplier.value, exchangeRate.value.rate) : loss?.cost_profile ?? null
    const includeProfile = !account || account.extra?.cockpit_historical !== true
      && (resolveAccountBillingMode(account) === 'subscription' || profile?.source === 'custom')
    return [id, recordedAccountCosts({
      profile: includeProfile ? profile : null,
      loss,
      records: records.get(id) ?? [],
      startMs: financeWindow.value.start.getTime(),
      endMs: financeWindow.value.end.getTime(),
      cnyPerUsd: exchangeRate.value.rate,
    })] as const
  }))
})
const financialRows = computed(() => [...financialCosts.value.values()])
const operatingMetadata = computed(() => {
  const metadata = new Map(accounts.value.filter(account => account.extra?.cockpit_historical !== true).map(account => [String(account.id), {
    billingMode: resolveAccountBillingMode(account), plan: inferPlan(account), provider: classifyUpstreamProvider(account) as UpstreamProviderKey | null,
  }]))
  for (const loss of latestCostLossByAccount.value.values()) {
    if (!metadata.has(String(loss.account_id)) && loss.account_type) {
      const billingMode = resolveAccountBillingMode({ type: loss.account_type as Account['type'] })
      const subscriptionProviders: Record<string, UpstreamProviderKey> = { openai: 'codex', anthropic: 'anthropic', gemini: 'gemini', antigravity: 'antigravity', grok: 'grok' }
      metadata.set(String(loss.account_id), { billingMode, plan: 'unknown', provider: billingMode === 'subscription' ? subscriptionProviders[loss.platform] ?? null : null })
    }
  }
  return metadata
})
const operatingUsageComplete = computed(() => operatingUsageReady.value && data.rangeAccountStatsComplete.value && sourceStates.value.rangeStats.status !== 'stale')
function operatingUsageForId(id: string): AccountWindowUsage | null {
  return operatingUsageReady.value ? data.rangeAccountStats.value[id] ?? null : null
}
const operatingRows = computed<OperatingAccount[]>(() => [...financialCosts.value].map(([accountId, financial]) => {
  const account = operatingMetadata.value.get(accountId)
  const usage = operatingUsageForId(accountId)
  const absent = operatingUsageComplete.value ? 0 : null
  const isUnattributedUsage = accountId === UNATTRIBUTED_USAGE_ACCOUNT_ID
  return {
    scope: operatingScope.value, accountId, isUnattributedUsage,
    billingMode: account?.billingMode ?? 'unknown',
    revenueUsd: connectionType.value === 'sub2api' ? usage ? finiteOrNull(usage.user_cost) : absent : null,
    meteredCostUsd: usage ? finiteOrNull(usage.cost) : absent,
    knownMeteredCostUsd: usage?.cost == null ? usage?.known_cost : undefined,
    referenceValueUsd: usage ? finiteOrNull(usage.standard_cost) : absent,
    knownReferenceValueUsd: usage?.standard_cost == null ? usage?.known_standard_cost : undefined,
    fixedExpenseCny: isUnattributedUsage ? 0 : financeError.value || financePending.value ? null : financial.windowExpenseCny,
    knownFixedExpenseCny: isUnattributedUsage ? 0 : financial.knownWindowExpenseCny,
    fixedHourlyCny: isUnattributedUsage ? 0 : financeError.value || financePending.value ? null : financial.hourlyCny,
    knownFixedHourlyCny: isUnattributedUsage ? 0 : financial.knownHourlyCny,
  }
}))
function summarizeOperatingRows(rows: OperatingAccount[]): OperatingSummary {
  const result = summarizeOperatingCosts({ scope: operatingScope.value, accounts: rows,
    startMs: financeWindow.value.start.getTime(), endMs: financeWindow.value.end.getTime(),
    cnyPerUsd: exchangeRate.value.rate, costMultiplier: cockpitCostMultiplier.value,
    outputBasis: connectionType.value === 'sub2api' ? 'revenue' : 'api_value',
    ...(connectionType.value === 'cliproxy' ? { accountInventoryComplete: currentAccountsReady.value && !['stale', 'unavailable', 'loading'].includes(sourceStates.value.accounts.status) } : {}) })
  if (!operatingUsageComplete.value && rows.length) {
    for (const value of [result.expenseCny, result.hourlyExpenseCny, result.referenceValueUsd, ...(connectionType.value === 'sub2api' ? [result.revenueUsd] : [])]) {
      value.total = null; value.unknownCount = Math.max(1, value.unknownCount)
    }
    result.contributionCny = null; result.projectedContributionCnyPerHour = null
  }
  return result
}
const operatingSummary = computed(() => summarizeOperatingRows(operatingRows.value))
const unassignedOperatingCount = computed(() => operatingRows.value.filter(row => !row.isUnattributedUsage && !operatingMetadata.value.get(row.accountId)?.provider).length)
const poolOperatingRows = computed(() => operatingRows.value.filter(row => poolPlatform.value === 'all'
  || operatingMetadata.value.get(row.accountId)?.provider === poolPlatform.value))
const poolOperatingSummary = computed(() => summarizeOperatingRows(poolOperatingRows.value))
const poolFinancialRows = computed(() => poolOperatingRows.value.map(row => financialCosts.value.get(row.accountId)!).filter(Boolean))
function operatingOutput(summary: OperatingSummary): AmountSummary { return connectionType.value === 'sub2api' ? summary.revenueUsd : summary.referenceValueUsd }
const operatingOutputSummary = computed(() => operatingOutput(operatingSummary.value))
const operatingHours = computed(() => usageWindowHours(financeWindow.value))
function scaleSummary(value: AmountSummary, factor: number | null): AmountSummary {
  return factor == null || !Number.isFinite(factor) ? { total: null, knownSubtotal: 0, unknownCount: Math.max(1, value.unknownCount) }
    : { total: value.total == null ? null : value.total * factor, knownSubtotal: value.knownSubtotal * factor, unknownCount: value.unknownCount }
}
function operatingRate(value: AmountSummary): AmountSummary { return scaleSummary(value, operatingHours.value ? 1 / operatingHours.value : null) }
const operatingState = computed<DataAvailability>(() => !operatingUsageReady.value ? 'partial'
  : operatingSummary.value.expenseCny.unknownCount || financeError.value ? 'partial' : 'estimated')
const operatingBasis = computed(() => t('costCenter.text.subscriptionsAccrueFromProcurementMeteredUsageUsesResolved', { value0: rangeLabel.value, value1: cockpitCostMultiplier.value, value2: unassignedOperatingCount.value ? t('costCenter.text.historicalAccountsLackTypeChannelAttribution', { value0: unassignedOperatingCount.value }) : '', value3: unattributedWindowRequests.value ? t('costCenter.text.requestsHaveNoAccountAssociationRateValuesShown', { value0: unattributedWindowRequests.value }) : '', value4: financeError.value ? t('costCenter.text.label', { value0: financeError.value }) : '' }))
const financialBasis = computed(() => {
  const entered = financialRows.value.filter(row => row.hasRecorded).length
  const estimate = financialRows.value.some(row => row.estimated)
  const partial = financialRows.value.some(row => row.partial)
  return [financePending.value ? t('costCenter.text.checkingEnteredPurchasesCostSettingsAreAProvisional') : entered ? t('costCenter.text.accountsAccrueFromEnteredPurchasesAndAdjustments', { value0: entered }) : t('costCenter.text.noPurchasesEnteredEstimatedFromCostSettings'),
    estimate ? t('costCenter.text.uncoveredPeriodsUsePlanPrices', { value0: cockpitCostMultiplier.value }) : '',
    partial ? t('costCenter.text.someRecordsLackAttributionOrDatesKnownAmounts') : '',
    financeError.value, t('costCenter.text.foreignCurrenciesConvertedAtThePageExchangeRate')].filter(Boolean).join(t('costCenter.text.label2'))
})
const financialState = computed<DataAvailability>(() => financialRows.value.some(row => row.partial) || financeError.value ? 'partial'
  : financialRows.value.some(row => row.estimated) ? 'estimated' : assetLedgerState.value)

const accountLedgers = computed(() => accounts.value.map((account) => {
  // 倍率兜底（用户口径）：未手动设置成本档案(source='default')→ 官方价 × 倍率；
  // 套餐信息缺失(plan='unknown')→ 按 Plus 官方价 UNKNOWN_PLAN_FALLBACK_USD 兜底后再 × 倍率，
  // 否则 0 × 倍率 = 0，当前价格/采购费率/累计采购整列空白。手动配置过的(custom)不套倍率。
  const profile = resolveFallbackCostProfile(account, cockpitCostMultiplier.value, exchangeRate.value.rate)
  const today = data.accountStats.value(account)
  // 观察窗口(range)逐账号用量:7d/30d 时上游排行列读这里,让窗口切换真正生效。
  // 无窗口数据(sub2api 源)→ null,由 usageStatsFor() 回退到 today。
  const windowStats = data.rangeStats.value(account)
  const usage = accountUsage.value[String(account.id)]
  const lossState = latestCostLossByAccount.value.get(String(account.id))
  const financial = financialCosts.value.get(String(account.id))!
  return {
    account,
    // cockpit 两层语义:无档案且非当前池的历史孤儿账号(已从 codex_accounts 移出,stats 残留累计)
    // 标 isHistorical——采购列显示"已移出当前池·无采购档案",不计入当前池采购 KPI
    isHistorical: account.extra?.cockpit_historical === true || account.extra?.cliproxy_identity_source === 'usage_only',
    billingMode: resolveAccountBillingMode(account),
    profile,
    usage,
    plan: inferPlan(account),
    lossState,
    financial,
    hourlyCny: financial.hourlyCny,
    procurementCny: financial.lifetimeProcurementCny,
    impairmentCny: financial.lifetimeLossCny,
    accruedCny: financial.lifetimeExpenseCny,
    elapsedHours: elapsedHours(profile.started_at, now.value),
    today,
    window: windowStats,
  }
}))
/** 账号排行表用量口径：优先统计时间(range)，无窗口数据时回退自然日。
 *
 *  2026-09-17:回退不再是无条件的。store 的 `rangeWindowAuthoritative` 为真表示
 *  **本次加载确实请求过逐账号窗口源**(sub2api 的 7d/30d)—— 此时缺失即"无数据",
 *  回退会把「今日」的数显示在「最近 7 天 / 最近 1 个月」的格子里(窗口口径不符)。
 *  其余源/窗口该标记为假,回退行为与改动前完全一致。 */
/** 逐行用量取值。语义判定收在 `accountRowUsageBasis.ts` 的**纯函数**里(由测试直测)——
 *  视图只做接线。**纯文本扫描钉不住语义**:把 `usageBasisOf` 改成恒返回 `'window'` 时,
 *  任何 `toContain('rowUsageSuffix(row)')` 都会照样全绿。 */
function usageStatsFor(row: { today: AccountWindowUsage | null; window: AccountWindowUsage | null }): AccountWindowUsage | null {
  return resolveUsageStatsFor(row, data.rangeWindowAuthoritative.value)
}
/** 逐行口径后缀:该行数值实际来自自然日时显式标出(与表头的窗口名并用,不取代表头)。 */
function rowUsageSuffix(row: { today: AccountWindowUsage | null; window: AccountWindowUsage | null }): string {
  return resolveRowUsageSuffix(row, data.rangeWindowAuthoritative.value)
}
/** 排行表"自算成本/用户计费"列的取值(2026-09-16 C2):必须按**值**判绿 ——
 *  对象非空 ≠ 有值。store 曾对缺失账号返回全 0 的 emptyTodayStats,
 *  于是 `$0.0000` 被渲染成绿色实测,note 还断言"{窗口}自算成本"。
 *  2026-09-16 续:store 的另一条回退路径(multiDayAccountRequests + 单请求用量库不可用)
 *  同样写死过 0 —— 现在那里写 null,`actualUserCost` 也改成"两个成本字段都不可用 ⇒ null",
 *  所以这里的 `Number.isFinite` 守卫才真正生效。 */
function rowUserCost(row: { today: AccountWindowUsage | null; window: AccountWindowUsage | null }): number | null {
  const stats = usageStatsFor(row)
  if (!stats) return null
  const value = connectionType.value === 'sub2api' ? actualUserCost(stats) : standardReferenceCost(stats)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
/** 该列显示"无数据"时的说明。区分三种无值,不留空 note(空白会让"无数据"看起来像没解释):
 *  ① 逐账号窗口源已被请求但不可用(sub2api 7d/30d)→ 用窗口源自己的原因;
 *  ② 整个源不可用 → 用源状态自己的原因;
 *  ③ 源可用、但该账号在此窗口没有成本记录(cockpit 快照缺该账号,日志只给出请求数)→ 明说不可测。 */
function rowUsageMissingLabel(row: { account: Account; today: AccountWindowUsage | null; window: AccountWindowUsage | null }): string {
  return connectionType.value === 'cliproxy' && hasMeasuredData(sourceStates.value.rangeStats) && row.account.extra?.cliproxy_identity_source === 'management' && row.account.extra?.cliproxy_usage_linked === false && !usageStatsFor(row) ? t('costCenter.text.unmatchedUsage') : t('costCenter.text.noData')
}
function rowUserCostNote(row?: { account: Account; today: AccountWindowUsage | null; window: AccountWindowUsage | null }): string {
  if (row && rowUsageMissingLabel(row) === t('costCenter.text.unmatchedUsage')) return t('costCenter.text.currentManagedAccountHasNoMatchingCpaUsage')
  if (data.rangeWindowAuthoritative.value && !hasMeasuredData(sourceStates.value.rangeStats)) {
    return sourceStates.value.rangeStats.reason || t('costCenter.text.perAccountWindowUsageUnavailableFor', { value0: costWindowCaption.value })
  }
  if (!hasMeasuredData(sourceStates.value.todayStats)) return sourceStates.value.todayStats.reason
  return t('costCenter.text.noCostRecordForThisAccountInCost', { value0: costWindowCaption.value })
}
/**
 * ★ 当前窗口相对**数据源实际覆盖范围**的判定(2026-09-24)。
 *
 * 病根:cockpit 用量库会停止写入。本机实测 186,353 行、跨度 50.7 天,末端停在
 * `2026-09-17T19:19:54Z`(距今 6.5 天)。而面板此前**无条件**标「(单请求用量库全程覆盖)」:
 *  · 短窗口(1m~24h)整段落在数据末端之后 ⇒ 窗口内 0 行;
 *  · 7d 窗口实际只被覆盖 11.3/168 小时(6.7%);30d 只覆盖 23.5/30 天。
 * ⇒ 那个 0 与那些偏小的数**都不是实测**,而是「**源没覆盖到这段**」。
 * 红线:「源不掌握 ≠ 实测为 0」。
 *
 * `state` 四态:`full`(全程覆盖,可直接当实测)/ `partial`(数值是**下界**)/
 * `uncovered`(该窗口**无数据**,不是 0)/ `unknown`(拿不到范围 ⇒ 不标注,不猜)。
 */
const cockpitCoverage = computed(() => cockpitWindowCoverage(
  range.value,
  cockpitDataSourceRange.value.startMs,
  cockpitDataSourceRange.value.endMs,
))
/** 数据源末端文案(UTC 日)。未知时为空串,`cockpitCoverageNote` 在 unknown 态不使用它。 */
const cockpitCoverageEndLabel = computed(() => cockpitDataSourceRange.value.endMs == null ? '' : formatUtcDay(cockpitDataSourceRange.value.endMs))
/** **所选时间内**被覆盖的那一段的文案(UTC 日);跨天时写成区间。`partial` 态用它 ——
 *  它与 `dataStart/EndLabel` 的区别:那两个是**数据源的范围**,这个是**与本窗口的交集**。 */
const cockpitCoveredRangeLabel = computed(() => {
  const { coveredStartMs, coveredEndMs } = cockpitCoverage.value
  if (coveredStartMs == null || coveredEndMs == null) return ''
  const a = formatUtcDay(coveredStartMs)
  const b = formatUtcDay(coveredEndMs)
  return a === b ? a : `${a} → ${b}`
})
/**
 * 窗口口径标注的统一出口:**请求列与成本列必须同源**,否则同屏会出现
 * 「成本列:最近 7 天」vs「请求列:最近 7 天(仅覆盖 …)」两个口径打架。
 * 措辞由纯函数 `cockpitCoverageNote` 生成(可直测 —— 文本扫描钉不住语义)。
 */
const cockpitWindowCoverageNote = computed(() => cockpitCoverageNote({
  state: cockpitCoverage.value.state,
  windowLabel: rangeLabel.value,
  dataEndLabel: cockpitCoverageEndLabel.value,
  coveredRangeLabel: cockpitCoveredRangeLabel.value,
  coveredPercent: Math.round(cockpitCoverage.value.coveredRatio * 100),
  // ★ 2026-09-24:`uncovered` 时面板展示的是**日历快照**口径(短窗口回退 daily,屏幕上有数字),
  //   所以要把快照窗口名(「今日累计」等)传进去,让措辞描述**屏幕上真正显示的东西**,
  //   而不是断言「该窗口无数据」—— 那会和同屏数字打架。
  //   `cockpitWindowLabel` 只在快照路径有值(单请求库窗口内有行时被置空)。
  snapshotLabel: cockpitWindowLabel.value || undefined,
}))

/**
 * ★ 2026-09-24:模型区是**独立一轨窗口**(`modelCostRange`),覆盖态必须按它单独算。
 *
 * 不能复用上面的 `cockpitCoverage` —— 那是按**主窗口** `range` 算的。用户把模型区切到
 * 「最近 7 天」、顶部仍留「最近 1 小时」时,复用会把模型表的覆盖态按 1 小时判,
 * 与它自己的窗口无关(项目里「同值双轨」用例抓不到的那类错配)。
 */
const modelWindowCoverage = computed(() => cockpitWindowCoverage(
  modelCostRange.value,
  cockpitDataSourceRange.value.startMs,
  cockpitDataSourceRange.value.endMs,
))
/** 模型区**所选时间内**被覆盖的那一段(UTC 日);`partial` 态用。 */
const modelCoveredRangeLabel = computed(() => {
  const { coveredStartMs, coveredEndMs } = modelWindowCoverage.value
  if (coveredStartMs == null || coveredEndMs == null) return ''
  const a = formatUtcDay(coveredStartMs)
  const b = formatUtcDay(coveredEndMs)
  return a === b ? a : `${a} → ${b}`
})
/**
 * 模型区回退到的**日历快照**窗口名(按 `modelCostRange` 选,不是主窗口)。
 * 判定复用 `cockpitWindowLabelForRange` —— 与 store 主路径**同一份**逻辑,
 * 各写一份迟早分叉,同屏就会出现两种口径。
 */
const modelSnapshotWindowLabel = computed(() => {
  if (connectionType.value !== null || !cockpitStats.value) return ''
  return cockpitWindowLabelForRange(cockpitStats.value, modelCostRange.value)
})
/** 模型区在单请求库口径下的覆盖措辞(与主窗口同一套纯函数出口)。 */
const modelWindowCoverageNote = computed(() => cockpitCoverageNote({
  state: modelWindowCoverage.value.state,
  windowLabel: modelCostRangeLabel.value,
  dataEndLabel: cockpitCoverageEndLabel.value,
  coveredRangeLabel: modelCoveredRangeLabel.value,
  coveredPercent: Math.round(modelWindowCoverage.value.coveredRatio * 100),
  snapshotLabel: modelSnapshotWindowLabel.value || undefined,
}))
/**
 * ★ 模型区副标题的窗口口径。
 *
 * **病根**:此前一律写被**请求**的窗口名(`modelCostRangeLabel`,如「最近 1 小时」)。
 * 而模型表在单请求库窗口内 0 行时会**回退到日历快照**(`useCostCenterData` 的
 * `rlModels.length ? … : cockpitModelsToModelStats(window)`),快照是 9/17 那天的 73 条 ——
 * 于是把「9/17 那天的今日累计」说成了「最近 1 小时」。**标签与数据实际窗口不符。**
 *
 * 三种情形分开写:
 * ① 非 cockpit 源:有真窗口端点,沿用被请求窗口名;
 * ② 数值来自单请求库:走覆盖四态措辞(覆盖不足时明说「数值为下界」);
 * ③ 快照口径:写**实际选中的快照窗口名**;源已停写时补「数据源止于 X」。
 *   ⚠️ ③ **不得**复用 ② 的措辞函数 —— 那个的 `full`/`partial` 两态都写着
 *   「**单请求用量库**全程覆盖 / 仅覆盖 …」,用在快照口径上是假口径。
 *   走 `cockpitSnapshotWindowNote`(同为纯函数,可直测)。
 */
const modelCostWindowLabel = computed(() => {
  if (connectionType.value !== null) return modelCostRangeLabel.value
  if (modelCostFromRequestLog.value) return modelWindowCoverageNote.value
  const snap = modelSnapshotWindowLabel.value
  if (!snap) return modelCostRangeLabel.value
  return cockpitSnapshotWindowNote({
    snapshotLabel: snap,
    state: modelWindowCoverage.value.state,
    dataEndLabel: cockpitCoverageEndLabel.value,
  })
})

/**
 * 「全局 API 成本速率」图的口径。
 *
 * ★ 2026-09-24:cockpit 分支此前写裸 `rangeLabel`(「最近 1 小时」),而该图的序列
 * (`trend`)在单请求库窗口内 0 行时**回退到日历快照**(`cockpitWindowsToCostTrend`)
 * ⇒ 图里画的是 9/17 那天的快照成本,标题却写「最近 1 小时」。
 * 改用 `costWindowCaption`(成本列同款、覆盖感知),与同屏成本列**同源**。
 */
const apiRateChartCaption = computed(() => connectionType.value === null
  ? t('costCenter.text.calculatedFromCockpitPerRequestUsage', { value0: costWindowCaption.value })
  : connectionType.value === 'cliproxy'
    ? t('costCenter.text.cpaUsageEventsHistoryMayIncludeDeletedAccounts', { value0: rangeLabel.value })
    : t('costCenter.text.historicalUsageLogsMayIncludeDeletedAccounts', { value0: rangeLabel.value }))

/** 是否真的在用统计时间数据(cockpit/cliproxy 提供逐账号窗口用量时为 true；sub2api 源回退自然日)。 */
const usesRangeWindow = computed(() => accountLedgers.value.some((row) => row.window != null))
/** 排行表用量列的表头口径文案，随统计时间变化，避免窗口切换后表头仍写"今日"。 */
/**
 * 窗口口径标签。cockpit 源(无远程连接)下 cockpitWindowForRange 只有 3 个快照:
 * 7d→weekly、30d→monthly、**其余 range(1m~24h/today)全部落到 daily(今日累计)**。
 * 此前标签直接取 rangeLabel,于是"今日累计"的数据被标成"最近 1 小时/最近 6 小时"——标签与数据不符。
 * 2026-09-06 修正:短窗口一律如实标注"今日累计"。
 */
const usageWindowLabel = computed(() => {
  if (connectionType.value === null) {
    // 2026-09-16 B1:数值来源是单请求用量库的精确 ms 滚动窗口 → 标签就是窗口名。
    // 此前 cockpitWindowLabel 被无条件写成"今日/本周/本月累计",7d 的 6,499 行被标成
    // weekly 快照口径(1,075 行),与同屏请求列"最近 7 天(单请求用量库全程覆盖)"自相矛盾。
    // ★ 2026-09-24:这里也必须走**共用覆盖出口** —— 本分支会被 :2588/:2607 在
    //   `!usesRangeWindow`(cockpit 逐账号窗口用量不可用)时消费,若返回裸 `rangeLabel.value`,
    //   覆盖标注会整个消失、下界又被说成完整窗口值。**同一份数据的第三个消费点,不许漏。**
    if (cockpitCostFromRequestLog.value) return cockpitWindowCoverageNote.value
    // 优先用 cockpit 实际选中的窗口标签(含回退情况),没有再按 range 推断
    // ★ 2026-09-24:快照口径下若数据源已停止写入,必须把「源止于哪天」一起说出来 ——
    //   否则「今日累计」会被读成"今天的数据"(实际是 9/17 那天的),而短窗口的滚动窗口
    //   其实**一点都没被覆盖**。措辞仍走**同一个出口** `cockpitWindowCoverageNote`
    //   (uncovered 态 = 快照窗口名 + 数据源止于 X),保证与成本列/请求列同源。
    if (cockpitWindowLabel.value) {
      return cockpitCoverage.value.state === 'uncovered'
        ? cockpitWindowCoverageNote.value
        : cockpitWindowLabel.value
    }
    if (range.value === '7d') return t('costCenter.text.thisWeekCumulative')
    if (range.value === '30d') return t('costCenter.text.thisMonthCumulative')
    return t('costCenter.text.todayCumulative')
  }
  // 2026-09-17:窗口源已被请求(rangeWindowAuthoritative)时,标签必须是**被请求的窗口名** ——
  // 即便本次没读到(sub2api 7d/30d 请求失败),格子显示的是"该窗口无数据",
  // 不能因为 usesRangeWindow 为假就退回写「今日」(那会把失败描述成另一个窗口)。
  if (data.rangeWindowAuthoritative.value) return rangeLabel.value
  return usesRangeWindow.value ? rangeLabel.value : t('costCenter.text.today')
})
/** cockpit 日历快照的起点日期(如 8/31),供"本周累计/本月累计"口径标注。 */
function cockpitWindowSinceLabel(sinceMs?: number): string {
  if (!sinceMs) return ''
  const d = new Date(sinceMs)
  return Number.isFinite(d.getTime()) ? `${d.getMonth() + 1}/${d.getDate()}` : ''
}
/**
 * 成本/用户计费列的窗口口径(2026-09-05 修复"7d/30d 数据是错的"):
 * cockpit 的 weekly/monthly 快照是日历累计(本周一/本月 1 日起),不是滚动 7/30 天窗口——
 * 实测 7d(8/31 起 5 天)$2,464 > 30d(9/1 起 4 天)$1,141,窗口越大数字越小。
 * 成本/Token 日志无字段,数字只能用快照累计,标签必须如实写"本周累计/本月累计"而非"最近 7 天"。
 * 非 cockpit 源(sub2api/cliproxy 有真窗口端点)沿用 rangeLabel。
 */
const costWindowCaption = computed(() => {
  const base = (() => {
    // 2026-09-16 B1:数值来自单请求用量库滚动窗口时,标签必须是窗口名 ——
    // 否则同屏出现"成本列:本周累计（8/31 起）"vs"请求列:最近 7 天（单请求用量库全程覆盖）"两个口径打架。
    // ★ 2026-09-24:再进一步 —— 不能只写窗口名。数据源会停止写入,覆盖不全时这个数是**下界**,
    //   必须与请求列**同源**标注(共用 cockpitWindowCoverageNote),否则成本列会把下界说成完整窗口值。
    if (connectionType.value === null && cockpitCostFromRequestLog.value) return cockpitWindowCoverageNote.value
    if (connectionType.value !== null || !usesRangeWindow.value) return usageWindowLabel.value
    // ★ 2026-09-24:日期必须跟**实际选中的快照**走,不能按 `range` 猜。
    // `cockpitWindowForRange` 有回退链(30d→monthly??weekly??daily、7d→weekly??monthly??daily):
    // 若 monthly 缺失而回退到 weekly,按 `range === '30d'` 写「本月累计（… 起）」
    // 就等于把 7 天的数说成了本月累计 —— 标签与数据实际窗口不符。
    // 标签本身已由 store 按**实际选中的窗口**给出,这里只补该窗口的真实起点日期。
    if (cockpitWindowLabel.value) {
      const snapshot = cockpitStats.value ? cockpitWindowForRange(cockpitStats.value, range.value) : undefined
      const since = cockpitWindowSinceLabel(snapshot?.since)
      const labeled = since ? t('costCenter.text.since', { value0: cockpitWindowLabel.value, value1: since }) : cockpitWindowLabel.value
      // 源已停写 ⇒ 走共用出口,把「数据源止于哪天」一并说出来(不再写一个会误导的"起"日期)
      return cockpitCoverage.value.state === 'uncovered'
        ? cockpitWindowCoverageNote.value
        : labeled
    }
    return usageWindowLabel.value
  })()
  // 2026-09-05:usage_logs 兼容聚合被 25,000 条上限截断时,趋势只绘制样本覆盖时段,标题如实标注。
  return trendTruncated.value ? t('costCenter.text.truncatedSamplesCoverageOfTheLatest25000', { value0: base }) : base
})
/**
 * 请求列的窗口口径:7d/30d 用日志聚合的真实滚动窗口;日志保留期覆盖不足时
 * 如实标注"日志自 X 起"(少计的时段不冒充);无日志聚合数据时回落快照口径标注。
 */
const requestWindowCaption = computed(() => {
  if (connectionType.value !== null || !usesRangeWindow.value) return usageWindowLabel.value
  // 请求量来自 codex-api 日志的真实滚动窗口聚合(2026-09-06 起 6h/24h 也走 Rust 多天聚合,
  // 此前只有 7d/30d);日志保留期不足时如实标注"日志自 X",不冒充完整窗口。
  // 2026-09-09:趋势首选单请求用量库(全保留期覆盖),不再受 codex-api.log ~4 天保留期限制;
  // 只有回退到日志聚合时才需要如实标注"日志自 X"。
  // ★ 2026-09-24:此前这里无条件写「(单请求用量库全程覆盖)」—— 而本机实测该库末端停在
  //   2026-09-17T19:19:54Z(距今 6.5 天),短窗口整段落在末端之后、7d 只覆盖 6.7%。
  //   「全程覆盖」是**假承诺**,会把「源没覆盖」读成「实测为 0 / 实测完整」。
  //   改为按真实覆盖四态动态措辞(full 才写全程覆盖;partial 写覆盖区间 + 数值为下界;
  //   uncovered 走**快照口径**措辞「今日累计（数据源止于 X）」—— 因为短窗口此时展示的
  //   是日历快照的数字,写「该窗口无数据」会和同屏数字打架)。
  //   ⚠️ `opsTrendFromRequestLog` 已经是「单请求库真的产出了桶序列」(`rlOps.length > 0`),
  //   与成本列的 `cockpitCostFromRequestLog` 判据同源,不需要额外处理。
  if (opsTrendFromRequestLog.value) return cockpitWindowCoverageNote.value
  const logRange = cockpitLogWindowRange.value
  const logBackedRanges = ['today', '1h', '6h', '24h', '7d', '30d']
  if (logRange && logBackedRanges.includes(range.value)) {
    const min = cockpitWindowSinceLabel(new Date(`${logRange.min}T00:00:00`).getTime())
    return t('costCenter.text.logsSince', { value0: rangeLabel.value, value1: min })
  }
  return usageWindowLabel.value
})
/** cockpit 历史孤儿账号数：仅 stats 残留累计、已从 cockpit 账号池移除(无 plan/无配额/无今日用量)。 */
const historicalOrphanCount = computed(() => accountLedgers.value.filter((row) => row.isHistorical).length)
/**
 * 渠道平均窗口余量(审查 #3)。`null` = 一个账号都没同步过窗口 —— 界面显示 `—`,
 * **绝不显示 0.0%**(那会被读成"配额已耗尽",而我们其实什么都不知道)。
 */
const quotaRemainingAverage = computed(() => averageQuotaRemaining(accountLedgers.value.map((row) => row.usage)))
const upstreamColumnCount = 16
const totalAccruedCny = computed(() => sumCompleteCosts(accountLedgers.value.filter((row) => !row.isHistorical).map(row => row.accruedCny)))
const archivedLatestCostLossStates = computed(() => [...latestCostLossByAccount.value.values()].filter((state) => state.account_deleted))
const currentImpairmentCny = computed(() => accountLedgers.value.reduce((sum, row) => sum + row.impairmentCny, 0))
// procurement(采购累计)独立于 costLoss 成立——cockpit 无封禁账本但采购档案真实。
// costLoss 只影响 impairment(封禁损失)部分。assetLedgerState 只看 accounts，不被 costLoss=unavailable 拖死。
const assetLedgerState = computed<DataAvailability>(() => hasMeasuredData(sourceStates.value.accounts) ? 'measured' : sourceStates.value.accounts.status)
const recordedLossReady = computed(() => financeSnapshot.value != null && !financePending.value && !financeError.value)
const recordedLossNote = computed(() => financeError.value || (financePending.value ? t('costCenter.text.localLedgerLoadingCurrentlyIncludesOnlySourceKnown') : t('costCenter.text.includesOnlySourceRecordedAndManuallyEnteredLosses')))
const windowImpairmentCny = computed<number | null>(() => hasMeasuredData(sourceStates.value.costLoss) || recordedLossReady.value
  ? financialRows.value.reduce((sum, row) => sum + row.windowLossCny, 0) : null)
const windowEconomicCostCny = computed(() => operatingSummary.value.expenseCny.total)
const procurementHourlyCny = computed(() => operatingSummary.value.fixedHourlyCny.total)
const currentMonthActiveOneTimeProcurementCny = computed(() => accountLedgers.value.filter((row) => !row.isHistorical).reduce((sum, row) => {
  if (row.profile.billing_cycle !== 'one_time' || !isStartedInLocalMonth(row.profile.started_at, now.value)) return sum
  return sum + convertCurrency(row.profile.amount, row.profile.currency, 'CNY', exchangeRate.value.rate)
}, 0))
const archivedMonthlyOneTimeStates = computed(() => archivedLatestCostLossStates.value.filter((state) => (
  state.cost_profile.billing_cycle === 'one_time' && isStartedInLocalMonth(state.cost_profile.started_at, now.value)
)))
const archivedMonthlyOneTimeCount = computed(() => archivedMonthlyOneTimeStates.value.length)
const archivedMonthlyOneTimeProcurementCny = computed(() => archivedMonthlyOneTimeStates.value.reduce((sum, state) => (
  sum + convertCurrency(state.cost_profile.amount, state.cost_profile.currency, 'CNY', exchangeRate.value.rate)
), 0))
const currentMonthOneTimeProcurementCny = computed(() => currentMonthActiveOneTimeProcurementCny.value + archivedMonthlyOneTimeProcurementCny.value)
const factualMonthOneTimeProcurementCny = computed(() => accountEconomics.value?.actual.month_one_time_procurement_cny)
const monthlyDeletedOneTimeCount = computed(() => accountEconomics.value?.actual.month_deleted_one_time_purchase_count ?? archivedMonthlyOneTimeCount.value)
/**
 * 已删除账号的**经常性**采购额 / 条数：**只有 sub2api 后端**有这本账
 * (`account_economics.go` 的 month_deleted_recurring_*)。
 * cockpit / cliproxy 的本地经济快照是 `costEngine.buildLocalEconomicsSnapshot` 构造的，
 * 不掌握 ⇒ 一律 `null`。这里**不得** `?? 0`：0 会让「本月采购投入」静默少算，
 * 且 note 无法说明缺口(红线：源不可用要用标注型空值，绝不静默变 0)。
 */
const monthlyDeletedRecurringProcurementCny = computed<number | null>(() => accountEconomics.value?.actual.month_deleted_recurring_procurement_cny ?? null)
const monthlyDeletedRecurringCount = computed<number | null>(() => accountEconomics.value?.actual.month_deleted_recurring_purchase_count ?? null)
/** 已删除账号快照总数。经常性那半不可得 ⇒ 整体不可得（不拿已知的一次性那半冒充总数）。 */
const monthlyDeletedPurchaseCount = computed<number | null>(() => {
  const recurring = monthlyDeletedRecurringCount.value
  if (recurring == null) return null
  return monthlyDeletedOneTimeCount.value + recurring
})
/**
 * 「本月采购投入」的 note：把**每一段是否计入**如实写出来，缺的那段说明原因。
 * 不能只写「含 N 个已删除账号快照」——N 可能只覆盖一次性采购。
 */
const monthlyProcurementNote = computed(() => {
  const deleted = monthlyDeletedPurchaseCount.value
  const deletedPart = deleted == null
    ? t('costCenter.text.includesOneTimePurchaseSnapshotsForDeletedAccounts', { value0: monthlyDeletedOneTimeCount.value })
    : t('costCenter.text.includesDeletedAccountSnapshots', { value0: deleted })
  const recurringPart = monthlyDeletedRecurringProcurementCny.value == null
    ? t('costCenter.text.excludesDeletedAccountsRecurringProcurementSourceHasNo')
    : t('costCenter.text.includesDeletedAccountsRecurringProcurement')
  return t('costCenter.text.currentRecurringRate730hThisMonthSPurchases', { value0: deletedPart, value1: recurringPart })
})
const monthlyProcurementForecastCny = computed<number | null>(() => procurementHourlyCny.value == null
  ? null
  : procurementHourlyCny.value * 730
    // sub2api 用后端事实值；cockpit/cliproxy 该字段为 null ⇒ 落到本地实测的本月一次性采购
    // （此前 costEngine 硬编码 0 会短路这个 `??`，把本地真实值整段丢弃 ⇒ 少算）
    + (factualMonthOneTimeProcurementCny.value ?? currentMonthOneTimeProcurementCny.value)
    // 经常性那半缺失时按 0 计入（= 不计入），缺口已由 monthlyProcurementNote 显式披露
    + (monthlyDeletedRecurringProcurementCny.value ?? 0))
const defaultCostProfileCount = computed(() => accountLedgers.value.filter(row => !row.isHistorical && isDefaultSubscriptionCostProfile(row.account) && (row.financial.estimated || row.financial.rateEstimated)).length)
/** 走"未知套餐兜底官方价 × 倍率"的账号数——这些账号无 plan_type,官方价表查不到,
 *  不兜底就是 0(整列空白)。UI 需明示这是推算值,不能冒充真实采购价。 */
const unknownPlanFallbackCount = computed(() => accountLedgers.value.filter(
  (row) => !row.isHistorical && row.billingMode === 'subscription' && row.profile.source === 'default' && row.profile.amount > 0
    && row.profile.algorithm_version.includes('+unknown-fallback') && (row.financial.estimated || row.financial.rateEstimated),
).length)
const costFallbackNote = computed(() => {
  if (!unknownPlanFallbackCount.value) return ''
  return t('costCenter.text.accountsLackPlanInformationEstimatedAtFallbackOfficial', { value0: unknownPlanFallbackCount.value, value1: UNKNOWN_PLAN_FALLBACK_USD, value2: cockpitCostMultiplier.value.toFixed(1) })
})
const todayAccountCostUsd = computed<number | null>(() => hasMeasuredData(sourceStates.value.todayStats)
  ? sumAccountCostUsd(Object.values(data.todayStats.value).map(today => ({ today }))) : null)
const localForecastDay = computed(() => {
  const start = new Date(now.value); start.setHours(0, 0, 0, 0)
  const end = new Date(start); end.setDate(end.getDate() + 1)
  return { hours: (end.getTime() - start.getTime()) / 3_600_000, elapsed: Math.max(1, (now.value.getTime() - start.getTime()) / 3_600_000), remaining: Math.max(0, (end.getTime() - now.value.getTime()) / 3_600_000) }
})
// 注:原 `selectedRangeHours`(窗口**名义**时长:7d=168h、30d=720h)已于 2026-09-25 移除 ——
//    所有 $/h 折算的分母改用下面的 `trendCoveredHours`(趋势实际覆盖时长),见其注释。
/**
 * 成本趋势点的桶长。cockpit 源下趋势点是"窗口累计"(非逐桶序列),
 * 折算 $/h 必须用该窗口的真实已过时长;用 range 查表桶长会把"今日累计"当成
 * 1 分钟/1 小时的量放大几十倍(2026-09-06 修复)。
 */
const trendBucketHours = computed(() => {
  if (data.trendBucketHours.value != null) return data.trendBucketHours.value
  // cockpit 单请求用量库给出的是**逐桶真实序列**:桶长就是桶本身(1h/24h),
  // 用窗口累计跨度(今日 ≈ 22h)去除会把每个点压扁几十倍、曲线贴底。
  if (connectionType.value === null && cockpitTrendBucketHours.value != null) return cockpitTrendBucketHours.value
  // 退化路径:趋势只有一个"窗口累计"点 → 用该窗口真实已过时长折算。
  if (connectionType.value === null && cockpitWindowHours.value != null) return cockpitWindowHours.value
  return resolveCostTrendBucketHours(range.value)
})
// Rates describe stored records over the completed query, not the gap between requests.
const trendCoveredHours = computed<number | null>(() => usageWindowHours(trendQueryWindow.value))
const trendSmoothingPoints = computed(() => ({ today: 4, '1m': 2, '5m': 3, '30m': 5, '1h': 10, '6h': 3, '24h': 4, '7d': 3, '30d': 7 })[range.value])
const rollingTrendLabel = computed(() => t('costCenter.text.pointMovingAverage', { value0: trendSmoothingPoints.value }))
const requestSmoothingPoints = computed(() => ({ today: 12, '1m': 2, '5m': 3, '30m': 5, '1h': 10, '6h': 6, '24h': 12, '7d': 6, '30d': 6 })[range.value])
const windowHasNoRecords = computed(() => hasMeasuredData(sourceStates.value.dashboard) && trendQueryWindow.value != null && trend.value.length === 0)
const windowActualOutputUsd = computed<number | null>(() => windowHasNoRecords.value ? 0 : hasMeasuredData(sourceStates.value.dashboard) ? sumFiniteTrendValues(trend.value.map((point) => point.actual_cost)) : null)
const windowAccountCostUsd = computed<number | null>(() => windowHasNoRecords.value ? 0 : hasMeasuredData(sourceStates.value.dashboard) ? sumFiniteTrendValues(trend.value.map((point) => point.account_cost ?? point.cost)) : null)
const apiCostBasisLabel = computed(() => trendUsesAccountCost.value ? t('costCenter.text.estimatedAccountExpense') : t('costCenter.text.sourceStandardReferenceValue'))
const apiOutputHourlyUsd = computed(() => operatingRate(operatingOutputSummary.value).total)
const combinedHourlyCny = computed(() => operatingSummary.value.hourlyExpenseCny.total)
const participationRequestTotal = computed<number | null>(() => operatingUsageReady.value
  ? operatingRows.value.reduce((sum, row) => sum + (operatingUsageForId(row.accountId)?.requests ?? 0), 0) : null)
const unattributedWindowRequests = computed(() => operatingUsageReady.value
  ? operatingUsageForId(UNATTRIBUTED_USAGE_ACCOUNT_ID)?.requests ?? 0 : 0)
const participationAssignmentNote = computed(() => participationRequestTotal.value == null ? sourceStates.value.rangeStats.reason
  : t('costCenter.text.associatedAccountIdsUnattributedRequestsUnattributedRequestsAre', { value0: formatInteger(participationRequestTotal.value - unattributedWindowRequests.value), value1: formatInteger(unattributedWindowRequests.value) }))
/**
 * ★ 顶部「最近 N 次调用」的覆盖注脚。
 * 覆盖标注此前只接到了**图表**,顶部 KPI 与「上游参与比例」都没接(第 N+1 个消费点)。
 * 源已完整覆盖时不加注脚(那是噪音);停写/覆盖不全时才说清数据止于哪天。
 */
const cockpitRequestCountNote = computed(() => {
  if (connectionType.value !== null || totalObservedRequests.value == null) return ''
  const state = cockpitCoverage.value.state
  if (state === 'full' || state === 'unknown' || !cockpitCoverageEndLabel.value) return ''
  return t('costCenter.text.sourceDataEndsAt', { value0: cockpitCoverageEndLabel.value })
})

const windowContributionCny = computed(() => operatingSummary.value.contributionCny)
const cnyPerBilledUsd = computed<number | null>(() => {
  const econ = windowEconomicCostCny.value
  const billed = operatingOutputSummary.value.total
  return econ == null || billed == null || billed <= 0 ? null : econ / billed
})
function unitCostPresentation(expense: AmountSummary, output: AmountSummary) {
  const basis = connectionType.value === 'sub2api' ? t('costCenter.text.sameWindowOperatingExpenseUserBillingAmount') : t('costCenter.text.sameWindowOperatingExpenseApiReferenceValue')
  if (expense.total != null && output.total != null && output.total > 0) {
    return { value: `${formatCny(expense.total / output.total, 4)}/USD`, note: basis, partial: false }
  }
  if (connectionType.value !== 'sub2api' && expense.total != null && expense.total >= 0 && output.total == null && output.knownSubtotal > 0) {
    return { value: `≤ ${formatCny(expense.total / output.knownSubtotal, 4)}/USD`, note: t('costCenter.text.upperBoundForPricedReferenceValueRecalculateWhen'), partial: true }
  }
  const missing = [expense.total == null ? t('costCenter.text.expenseItems', { value0: expense.unknownCount }) : '', output.total == null ? t('costCenter.text.referenceValueItems', { value0: output.unknownCount }) : ''].filter(Boolean)
  return { value: t('costCenter.text.knownExpenseKnownReference', { value0: formatCny(expense.knownSubtotal, 4), value1: formatUsd(output.knownSubtotal, 4) }),
    note: missing.length ? t('costCenter.text.missing', { value0: missing.join(t('costCenter.text.label3')), value1: basis }) : t('costCenter.text.noPositiveOutputInTheSelectedPeriodUnit'), partial: true, unresolved: true }
}
const overviewUnitCost = computed(() => unitCostPresentation(operatingSummary.value.expenseCny, operatingOutputSummary.value))
const poolUnitCost = computed(() => unitCostPresentation(poolOperatingSummary.value.expenseCny, oauthWindowOutputSummary.value))
const paybackRatio = computed<number | null>(() => {
  const econ = windowEconomicCostCny.value
  const billed = operatingSummary.value.revenueUsd.total
  return econ == null || billed == null || econ <= 0 ? null : billed * exchangeRate.value.rate / econ
})
const projectedContributionHourlyCny = computed(() => operatingSummary.value.projectedContributionCnyPerHour)
const estimatedPaybackHours = computed<number | null>(() => {
  const econ = windowEconomicCostCny.value
  const billed = operatingSummary.value.revenueUsd.total
  if (econ == null || billed == null) return null
  const outstanding = Math.max(0, econ - billed * exchangeRate.value.rate)
  if (outstanding <= 0) return 0
  const perHour = projectedContributionHourlyCny.value
  return perHour == null || perHour <= 0 ? null : outstanding / perHour
})

const accountEconomics = computed<AccountEconomicsSnapshot | null>(() => {
  const base = sourceAccountEconomics.value
  if (!base) return null
  const summary = operatingSummary.value
  const output = operatingOutput(summary).total
  const financial = financialRows.value
  const expense = summary.expenseCny.total
  const billed = summary.revenueUsd.total
  return {
    ...base,
    scope: {},
    health: { ...base.health, account_count: currentAccounts.value.length, normal_count: activeAccounts.value.length,
      rate_limited_count: currentAccountHealth.value?.limited ?? base.health.rate_limited_count,
      error_count: currentAccountHealth.value?.error ?? base.health.error_count,
      healthy_ratio: currentAccounts.value.length ? activeAccounts.value.length / currentAccounts.value.length : 0 },
    actual: {
      ...base.actual,
      billed_usd: output,
      account_cost_usd: summary.meteredExpenseCny.total == null ? null : summary.meteredExpenseCny.total / exchangeRate.value.rate,
      procurement_accrued_cny: financial.reduce((sum, row) => sum + row.lifetimeProcurementCny, 0),
      impairment_loss_cny: financial.reduce((sum, row) => sum + row.lifetimeLossCny, 0),
      economic_cost_cny: sumCompleteCosts(financial.map(row => row.lifetimeExpenseCny)),
      window_procurement_cny: financial.reduce((sum, row) => sum + row.windowProcurementCny, 0),
      window_impairment_loss_cny: financial.reduce((sum, row) => sum + row.windowLossCny, 0),
      window_economic_cost_cny: expense,
      contribution_margin_cny: summary.contributionCny,
      cny_per_billed_usd: expense != null && output != null && output > 0 ? expense / output : null,
      payback_ratio: expense != null && expense > 0 && billed != null ? billed * exchangeRate.value.rate / expense : null,
      projected_contribution_cny_per_hour: summary.projectedContributionCnyPerHour,
      estimated_payback_hours: null,
    },
    projection: { ...base.projection, confidence: operatingUsageReady.value ? 'low' : 'unavailable', valid_intervals: 0,
      warning: t('costCenter.text.averageOfRecordedUsageForAllAccountsNot'), coverage_hours: operatingHours.value ?? 0,
      billed_usd_per_hour: operatingRate(operatingOutput(summary)).total,
      capacity_adjusted_billed_usd_per_hour: operatingRate(operatingOutput(summary)).total,
      account_cost_usd_per_hour: operatingRate(scaleSummary(summary.meteredExpenseCny, 1 / exchangeRate.value.rate)).total,
      capacity_adjusted_account_cost_usd_per_hour: operatingRate(scaleSummary(summary.meteredExpenseCny, 1 / exchangeRate.value.rate)).total },
    data_quality: { ...base.data_quality, status: summary.expenseCny.unknownCount ? 'partial' : 'estimated' },
  }
})

const trendLabels = computed(() => opsTrend.value.length ? opsTrend.value.map((point) => formatTrendLabel(point.bucket_start)) : trend.value.map((point) => formatTrendLabel(point.date)))
const opsBucketHours = computed(() => {
  if (opsTrend.value.length < 2) return trendBucketHours.value
  const left = new Date(opsTrend.value[0].bucket_start).getTime()
  const right = new Date(opsTrend.value[1].bucket_start).getTime()
  const hours = Math.abs(right - left) / 3_600_000
  return Number.isFinite(hours) && hours > 0 ? hours : trendBucketHours.value
})
const financialTrend = computed(() => selectFinancialTrend(
  opsTrend.value,
  trend.value,
  opsBucketHours.value,
  trendBucketHours.value,
))
/** 成本趋势里是否混有"部分成本不可得"的桶。此时数值仍是**真实下界**(不是假数),但必须标注,
 *  否则读者会把下界当成完整成本。全桶未知的桶数值已是 null(渲染「无数据」),不在此列。
 *
 *  ★ 归因必须与真实原因一致(2026-09-21 复核):`source_estimate` 这一态有两个来源 ——
 *  cockpit/cliproxy 是「桶内有模型没匹配到单价」;sub2api 是「桶内有记录缺 actual_cost 字段」。
 *  此前一律写"部分模型无单价",在 sub2api 下是**假口径**(原因归属错)。 */
const trendCostPartial = computed(() => financialTrend.value.some((point) => point.costPartial))
const trendCostPartialSuffix = computed(() => t('costCenter.text.averageOfRecordedUsageNotProofOfContinuous') + (!trendCostPartial.value
  ? ''
  : connectionType.value === null || connectionType.value === 'cliproxy'
    ? t('costCenter.text.someModelsLackPricesValueIsALower')
    : t('costCenter.text.someRecordsLackCostFieldsValueIsA')))
const trendFinancialUsesOps = computed(() => financialTrend.value[0]?.source === 'ops')
const trendFinancialState = computed(() => trendFinancialUsesOps.value ? sourceStates.value.ops : sourceStates.value.dashboard)
const trendFinancialReason = computed(() => trendFinancialUsesOps.value
  ? sourceStates.value.ops.reason
  : opsTrend.value.length && trend.value.length
    ? (connectionType.value === null
      ? t('costCenter.text.opsPointsLackEconomicFieldsSameWindowCockpit')
      : connectionType.value === 'cliproxy'
        ? t('costCenter.text.opsPointsLackEconomicFieldsSameWindowCpa')
        : t('costCenter.text.opsPointsLackEconomicFieldsSameWindowUsage'))
    : sourceStates.value.dashboard.reason)
function financialPointHours(point: { timestamp: string; bucketHours: number; source: 'ops' | 'usage_logs' }) {
  if (connectionType.value === null && !cockpitCostFromRequestLog.value && point.source === 'usage_logs') return trendCoveredHours.value
  return usageBucketHours(point.timestamp, point.bucketHours, trendQueryWindow.value)
}
const trendActualCost = computed(() => financialTrend.value.map((point) => divideFiniteChartValue(point.billedUsd, financialPointHours(point))))
const rollingTrendActualCost = computed(() => movingAverage(trendActualCost.value, trendSmoothingPoints.value))
const rollingOutputUsd = computed<number | null>(() => hasMeasuredData(sourceStates.value.dashboard) ? rollingTrendActualCost.value.at(-1) ?? apiOutputHourlyUsd.value : null)
const trendStandardCost = computed(() => financialTrend.value.map((point) => multiplyFiniteChartValue(divideFiniteChartValue(point.accountCostUsd, financialPointHours(point)), exchangeRate.value.rate)))
const procurementBaseline = computed(() => financialTrend.value.map(() => procurementHourlyCny.value))
const trendCombinedCost = computed(() => financialTrend.value.map(() => combinedHourlyCny.value))
const qualityTrendLabels = computed(() => opsTrend.value.length ? opsTrend.value.map((point) => formatTrendLabel(point.bucket_start)) : trendLabels.value)
const requestVolumeTrend = computed(() => opsTrend.value.length ? opsTrend.value.map((point) => Number(point.request_count || 0)) : trend.value.map((point) => Number(point.requests || 0)))

const platformDistributionUsesCost = computed(() => accountLedgers.value.every(row => row.accruedCny != null)
  && accountLedgers.value.some(row => row.accruedCny! > 0))
const platformDistribution = computed(() => {
  const totals = new Map<string, number>()
  for (const row of accountLedgers.value) {
    const value = platformDistributionUsesCost.value ? row.accruedCny! : 1
    totals.set(row.account.platform, (totals.get(row.account.platform) || 0) + value)
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1])
})
const platformDonutModeLabel = computed(() => currentImpairmentCny.value > 0
  ? t('costCenter.text.economicCostIncludingBanLosses')
  : platformDistributionUsesCost.value ? t('costCenter.text.cumulativeProcurementConfigurationEstimate') : t('costCenter.text.procurementNotConfiguredRingShowsAccountComposition'))
const platformDonutLabel = computed(() => platformDistribution.value.map(([name, value]) => platformDistributionUsesCost.value ? `${name} ${formatCny(value, 2)}` : t('costCenter.text.accounts', { value0: name, value1: formatInteger(value) })).join(t('costCenter.text.label4')))

const accountDistribution = computed(() => {
  const total = participationRequestTotal.value
  if (!total) return []
  const current = new Map(accounts.value.map(account => [String(account.id), account]))
  const requests = (id: string) => operatingUsageForId(id)?.requests ?? 0
  const rows = operatingRows.value.filter(row => !row.isUnattributedUsage && requests(row.accountId) > 0).sort((a, b) => requests(b.accountId) - requests(a.accountId))
  const visible = rows.slice(0, 6).map((row, index) => ({
    id: row.accountId, name: current.get(row.accountId)?.name ?? latestCostLossByAccount.value.get(row.accountId)?.account_name ?? t('costCenter.text.historicalAccount', { value0: row.accountId }),
    platform: current.get(row.accountId)?.platform ?? t('costCenter.text.channelUnattributed'), hourlyCost: financialCosts.value.get(row.accountId)?.hourlyCny ?? null,
    isUnattributed: false, share: requests(row.accountId) / total, value: requests(row.accountId), color: distributionColors[index % distributionColors.length],
  }))
  const others = rows.slice(6)
  if (others.length) {
    const count = others.reduce((sum, row) => sum + requests(row.accountId), 0)
    visible.push({ id: 'usage:other_accounts', name: t('costCenter.text.otherAccounts'), platform: t('costCenter.text.accountsCombined', { value0: others.length }),
      hourlyCost: sumCompleteCosts(others.map(row => financialCosts.value.get(row.accountId)?.hourlyCny ?? null)),
      isUnattributed: false, share: count / total, value: count, color: distributionColors[6] })
  }
  if (unattributedWindowRequests.value) visible.push({ id: UNATTRIBUTED_USAGE_ACCOUNT_ID, name: t('costCenter.text.unattributedRequests'), platform: t('costCenter.text.noAssociatedAccountId'), hourlyCost: null,
    isUnattributed: true, share: unattributedWindowRequests.value / total, value: unattributedWindowRequests.value, color: '#de8b51' })
  return visible
})
const accountDonutBackground = computed(() => donutGradient(accountDistribution.value))

function rankingValue(row: { score: number; today: AccountWindowUsage | null; window?: AccountWindowUsage | null; account: Account; usage?: AccountUsageInfo }, metric: RankingMetric): number {
  // 排行依据同样跟随观察窗口(否则窗口切到 7d/30d,排序仍按"今日"数据算,切换无效)
  const usage = row.window ?? row.today
  if (metric === 'output') return rowUserCost({ today: row.today, window: row.window ?? null }) ?? Number.NEGATIVE_INFINITY
  if (metric === 'requests') return usage ? Number(usage.requests || 0) : Number.NEGATIVE_INFINITY
  if (metric === 'cost') return usage ? Number(usage.cost || 0) : Number.NEGATIVE_INFINITY
  if (metric === 'reliability') {
    const state = currentAccountState(row.account)
    const statusScore = state.state === 'normal' ? 1 : 0
    const schedulableScore = state.state === 'normal' || state.state === 'limited' ? 1 : 0
    // 排序键不是展示值:无窗口的账号排在最后即可(0 = 余量最低),界面上仍显示 `—`。
    return statusScore * 2 + schedulableScore + row.score / 100 + (quotaRemainingRatio(row.usage) ?? 0)
  }
  if (metric === 'latency') {
    // 延迟证据**按源不同**:cockpit 的 `probes` 恒为空,真实延迟在 cockpitAvgLatency 里。
    // 只读 `probes` 会让 cockpit 的排序键全是 +∞ ⇒ 排不出来。
    return latencyRankingProbe(sourceKind.value, probes.value[String(row.account.id)], cockpitAvgLatency(row.account.id))?.latency_ms
      ?? Number.POSITIVE_INFINITY
  }
  return row.score
}

const cockpitStatsByCostId = computed(() => new Map((cockpitStats.value?.accounts ?? []).map(account => [statsAccountCostId(account), account])))
function cockpitAvgLatency(accountId: CostAccountId): number | null {
  if (connectionType.value === 'cliproxy') return data.cliproxyLatencyMap.value[String(accountId)] ?? null
  if (connectionType.value !== null) return null
  const account = cockpitStatsByCostId.value.get(String(accountId))
  if (!account) return null
  const latency = Number(account.usage.totalLatencyMs)
  const count = Number(account.usage.requestCount)
  return Number.isFinite(latency) && Number.isFinite(count) && count > 0 ? Math.round(latency / count) : null
}

/** Same selected-window configured rate estimate as the operating summary, not today's usage. */
function meteredHourlyCny(row: { today: AccountWindowUsage | null; window: AccountWindowUsage | null }): number | null {
  const cost = usageStatsFor(row)?.cost
  const hours = operatingHours.value
  if (!operatingUsageReady.value || cost == null || !Number.isFinite(cost) || !hours) return null
  return (cost / hours) * exchangeRate.value.rate
}

/** 按量账号全量 API 成本(USD)。
 *  优先用**本项目自算**的累计成本(单请求用量库 × 价目表,含长上下文档位价);
 *  库不可用时回退 cockpit stats 累计估算(含已移出池前的历史)。
 *  使用完整来源身份匹配，未知计价依据不从裸金额反推。
 *  ⚠️ **仅 cockpit 源可用**(见下方源守卫)。 */
function cockpitAllTimeCostUsd(accountId: CostAccountId): number | null {
  // 源守卫(2026-09-16):cockpitStats / cockpitCumulativeAccountCost **只由 cockpit 路径写入**,
  // 而消费点(上游排行「累计采购」列 :576)对所有连接类型都渲染,procurementBasis(:2747)
  // 还会据此把取值依据标成 measured —— 连 cliproxy/sub2api 时那一列显示的是 cockpit 的
  // 历史账号成本,却被标成"实测"。非 cockpit 连接下一律 null(UI 显示"无数据")。
  if (connectionType.value !== null) return null
  const account = cockpitStatsByCostId.value.get(String(accountId))
  if (!account) return null
  const cell = resolveCostCell({ selfCost: cockpitCumulativeAccountCost.value?.[account.accountId], selfCostBasis: cockpitCumulativeAccountBasis.value?.[account.accountId], sourceEstimate: account.usage.estimatedCostUsd })
  return cell.costBasis === 'no_price_no_estimate' && !cell.costPartial ? null : cell.costUsd
}

function cockpitCumulativePartial(accountId: CostAccountId): boolean {
  const account = cockpitStatsByCostId.value.get(String(accountId))
  return connectionType.value === null && !!account && cockpitCumulativeAccountBasis.value?.[account.accountId] === 'no_price_no_estimate'
}

/** 复制文本到剪贴板(用 navigator.clipboard API,Tauri WebView2 支持)。 */
function copyToClipboard(text: string) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => {})
  }
}

// 配额利用率分级 / 余量计算已移入 `@/features/cost-center/honestValues`。
// 原实现 `Number(null)=0` ⇒ 未知利用率落进绿色 'high' 健康态,属于"暗示未掌握的信息"。

/** stats.apiKeys(累计按 Key 用量)→ Map<apiKeyId, stat>,供 API 接入页合并展示真实请求/成本。 */
const cockpitApiKeyStatsMap = computed(() => {
  const map = new Map<string, NonNullable<CockpitStats['apiKeys']>[number]>()
  for (const k of cockpitStats.value?.apiKeys ?? []) map.set(k.apiKeyId, k)
  return map
})

/** stats.models(累计按模型用量)→ Map<modelId, usage>,供定价表补充窗口用量/成本列。 */
const cockpitModelUsageMap = computed(() => {
  const map = new Map<string, CockpitModelUsage['usage']>()
  for (const m of cockpitStats.value?.models ?? []) map.set(m.modelId, m.usage)
  return map
})

/** 定价表行:本地目录行合并真实用量 + 目录外有用量但无定价的模型(诚实标"无本地定价")。
 *  costUsd = 本项目按价目表 × 分档 token 自算的**累计**成本(含长上下文档位价);
 *  单请求用量库不可用时回退数据源估算,由 costIsOurs=false 标注。 */
const cockpitPricingRows = computed(() => {
  // 必须用**有效价目**(内置价目表 + 用户手动覆盖),不能只读 modelPricings:
  // cockpit 只把手动改过的价目落盘(本机仅 2 条),内置价目表在二进制里不落盘,
  // 直接读 modelPricings 会让定价目录只剩 2 个模型(2026-09-08 修复)。
  const pricings = cockpitEffectiveModelPricings(cockpitLocalAccess.value?.modelPricings)
  const usageMap = cockpitModelUsageMap.value
  const priced = new Set(pricings.map((m) => m.modelId))
  const ours = cockpitCumulativeModelCost.value
  const withCost = (modelId: string, usage: CockpitUsageStats | null) => {
    // 审查 #2:自算值与数据源估算**都缺**时不能再回退 0 —— 那是把"算不出"冒充成"不花钱"。
    // 走 PricedCost 三态,模板按 costBasis === 'no_price_no_estimate' 显示「成本未知」。
    return { modelId, usage, ...resolveCostCell({ selfCost: ours?.[modelId], selfCostBasis: cockpitCumulativeModelBasis.value?.[modelId], sourceEstimate: usage?.estimatedCostUsd }) }
  }
  const unpriced = [...usageMap.entries()]
    .filter(([id]) => !priced.has(id))
    .map(([modelId, usage]) => ({ pricing: null, ...withCost(modelId, usage) }))
  return [
    ...pricings.map((m) => ({ pricing: m, ...withCost(m.modelId, usageMap.get(m.modelId) ?? null) })),
    ...unpriced,
  ]
})

/** API Key 表行:local_access 密钥清单(有 key 材料)合并 stats 用量;
 *  stats 里存在但本地清单没有的 key 单独成行(无 key 材料,仅用量,诚实展示)。 */
const cockpitApiKeyRows = computed(() => {
  const localKeys = cockpitLocalAccess.value?.apiKeys ?? []
  const statsMap = cockpitApiKeyStatsMap.value
  const ours = cockpitCumulativeApiKey.value
  const seen = new Set<string>()
  const withCost = <T extends { id?: string }>(k: T, stat: CockpitApiKeyStat | null) => {
    const self = k.id ? ours?.[k.id] : undefined
    return {
      ...k,
      stat,
      // 自算优先(含长上下文档位价);无则回退 stats 累计估算并标注;
      // 两者都没有 ⇒ costBasis = no_price_no_estimate,模板显示「成本未知」而不是 $0.00(审查 #2)。
      ...resolveCostCell({ selfCost: self?.cost, sourceEstimate: stat?.usage.estimatedCostUsd }),
    }
  }
  const rows = localKeys.map((k) => withCost(k, statsMap.get(k.id ?? '') ?? null))
  for (const k of rows) if (k.id) seen.add(k.id)
  for (const s of statsMap.values()) {
    if (!seen.has(s.apiKeyId)) rows.push(withCost({ id: s.apiKeyId, label: s.label || s.apiKeyId } as { id: string; label?: string }, s))
  }
  return rows
})

/** 调度评分的取值依据。`measured` = 内核实测调度分,`derived` = 由账号状态推算(非内核调度分)。 */
type SchedulerScoreBasis = 'measured' | 'derived'

/** 采购列的取值依据。
 *  `measured`  = 按量实测(cockpit 全量 API 成本 / 今日成本 ÷ 今日已过小时);
 *  `estimated` = 用默认套餐价或用户成本档案**推算**出来的,不是实测采购价;
 *  `none`      = 这一格根本不是数字('—' / '无数据' / '按 Token' / '按用量累计')。 */
type ProcurementBasis = 'measured' | 'estimated' | 'none'

/**
 * 采购列(采购费率 / 累计采购)的取值依据。
 *
 * 分支条件与模板里那两列的取值表达式**逐条对齐**,避免"数字按一套条件算、依据按另一套条件判"
 * 造成标注错位(此前整列都是实测强调色 lime,推算值和实测值长得一模一样)。
 */
function procurementBasis(
  isHistorical: boolean,
  billingMode: string,
  profileSource: string,
  measuredValue: number | null,
): ProcurementBasis {
  if (isHistorical || assetLedgerState.value === 'unavailable') return 'none'
  if (billingMode === 'metered' && profileSource !== 'custom') {
    return measuredValue == null ? 'none' : 'measured'
  }
  return 'estimated'
}

/** 号池分组表产出/成本列的类名:只有**真读到数值**才用实测绿(lime);
 *  无值(formatUsd/formatCny 会渲染成"无数据")一律走未知色 ——
 *  不得把"无数据"渲染成绿色(2026-09-16 C1:cliproxy 分支把 outputUsd/hourlyCny/apiCostUsd 全写死 null,
 *  此前每行渲染"无数据 / 无数据"却是绿色)。 */
function poolValueClass(...values: Array<number | null | undefined>): string {
  return values.some((value) => value == null || !Number.isFinite(value)) ? 'cost-unknown-value' : 'cost-lime'
}

/** 采购列数字的类名:实测用强调色(lime),推算用中性色;推算值绝不与实测值同外观。 */
function procurementStrongClass(basis: ProcurementBasis): string {
  // measured → 实测强调色;estimated → 中性灰(推算);none('—'/'无数据'/'按 Token'/'按用量累计')→ 中性灰。
  // 三者外观必须互不相同,否则推算/未知会被读成实测(红线:推算不得与实测同外观)。
  return basis === 'measured' ? 'cost-lime' : basis === 'estimated' ? 'cost-estimated' : 'cost-unknown-value'
}

const accountDisplayUsage = computed(() => connectionType.value === null
  ? cockpitSnapshotsToAccountUsage(channelQuota.allSnapshots.value, accounts.value, accountUsage.value)
  : accountUsage.value)
function accountQuotaWindows(usage: AccountUsageInfo | undefined) {
  if (!usage) return []
  const periods: Array<{ key: string; label: string; reading: QuotaWindowReading | null | undefined }> = []
  if (usage.five_hour || usage.seven_day || usage.seven_day_sonnet) {
    periods.push({ key: '5h', label: '5h', reading: usage.five_hour }, { key: '7d', label: '7d', reading: usage.seven_day })
  }
  if (usage.seven_day_sonnet) periods.push({ key: 'sonnet-7d', label: 'Sonnet·7d', reading: usage.seven_day_sonnet })
  for (const [model, reading] of Object.entries(usage.antigravity_quota ?? {})) periods.push({ key: `model:${model}`, label: model.slice(0, 8), reading })
  return periods.map(period => ({ ...period, provided: !!period.reading, state: quotaWindowState(period.reading, now.value.getTime()) }))
}
const upstreamRows = computed(() => {
  const query = searchQuery.value.toLowerCase()
  const rows = accountLedgers.value
    // 默认隐藏 cockpit 历史孤儿(已移除账号的 stats 残留):它们无套餐/无配额/无今日用量,
    // 混在主表会让状态、评分、用量窗口、成本列全部显示为 0 或默认值,掩盖真实号池。
    .filter((row) => showHistoricalAccounts.value || !row.isHistorical)
    .filter((row) => matchesUpstreamProvider(row.account, platformFilter.value))
    .filter((row) => !query || [row.account.name, row.account.notes, row.account.platform, accountOriginLabel(row.account), ...costAccountGroupNames(row.account)].some((value) => String(value || '').toLowerCase().includes(query)))
    .map((row) => {
      const rawScore = Number(row.account.scheduler_score?.base_score)
      const hasScore = row.account.scheduler_score?.base_score != null && Number.isFinite(rawScore)
      const hasRawScore = hasScore && row.account.extra?.scheduler_score_source !== 'derived'
      // cockpit/cliproxy 无 sub2api 调度分：用 account 状态(健康/success/failure)派生 0-100 真实分
      // ★ 这是**推算值,不是内核调度分**。scoreBasis 把来源如实带给模板,由模板标注 + 换样式,
      //   绝不能让派生分顶着实测分的外观出现(红线:不得暗示系统掌握了它并不掌握的信息)。
      const fallbackScore = (() => {
        const state = currentAccountState(row.account)
        if (state.state === 'error') return 0
        if (state.state === 'limited') return 40
        if (state.state === 'normal') {
          // 有今日请求的正常账号：用成功/失败比算分
          const req = Number(row.today?.requests || 0)
          if (req === 0) return 50 // 正常但无请求：中位
          return 80 // 正常且有请求：良好
        }
        return 0
      })()
      const effectiveScore = hasScore ? normalizeSchedulerScore(rawScore, schedulerBaseScoreMax.value) : fallbackScore
      return {
        ...row,
        score: effectiveScore,
        // ★ scoreRaw 只放**内核实测原始分**。走 fallbackScore 时保持 null ——
        //   把派生值塞进 scoreRaw 会让模板的"无数据/推算"分支永远走不到,派生分就冒充成实测分了。
        scoreBasis: (hasRawScore ? 'measured' : 'derived') as SchedulerScoreBasis,
        scoreRaw: hasRawScore ? rawScore : null,
        scoreMax: hasRawScore ? schedulerBaseScoreMax.value : 100,
        hourlyCost: row.hourlyCny,
        accrued: row.accruedCny,
        // 采购费率/累计采购这一格是"实测"还是"默认套餐价推算" ——
        // 模板据此决定是否加「推算」标记并换掉实测强调色(红线:推算不得与实测同外观)。
        procurementRateBasis: procurementBasis(row.isHistorical, row.billingMode, row.profile.source, meteredHourlyCny(row)),
        procurementAccruedBasis: cockpitCumulativePartial(row.account.id) ? 'estimated' as const : procurementBasis(row.isHistorical, row.billingMode, row.profile.source, cockpitAllTimeCostUsd(row.account.id)),
        currentState: currentAccountState(row.account),
        groups: costAccountGroupNames(row.account),
      }
    })
    .map((row) => ({
      ...row,
      rankingEligible: hasAccountRankingEvidence(rankingMetric.value, {
        outputUsd: rowUserCost(row),
        // 排行证据同样按观察窗口判定,与列的取数口径保持一致
        today: usageStatsFor(row),
        // 延迟指标的证据按源取(见 latencyRankingProbe);其余指标仍用主动探测结果,
        // 避免顺手改掉 reliability 指标的既有口径。
        probe: rankingMetric.value === 'latency'
          ? latencyRankingProbe(sourceKind.value, probes.value[String(row.account.id)], cockpitAvgLatency(row.account.id))
          : probes.value[String(row.account.id)],
        state: row.currentState.state,
      }),
    }))
  let rank = 0
  return rows
    .sort((a, b) => {
      if (a.rankingEligible !== b.rankingEligible) return a.rankingEligible ? -1 : 1
      const aValue = rankingValue(a, rankingMetric.value)
      const bValue = rankingValue(b, rankingMetric.value)
      if (rankingMetric.value === 'latency') {
        const aMissing = !Number.isFinite(aValue)
        const bMissing = !Number.isFinite(bValue)
        if (aMissing !== bMissing) return aMissing ? 1 : -1
        return aValue - bValue || b.score - a.score
      }
      return bValue - aValue || b.score - a.score
    })
    .map((row) => {
      const usage = accountDisplayUsage.value[String(row.account.id)]
      return { ...row, rank: row.rankingEligible ? ++rank : null, usage, quotaWindows: accountQuotaWindows(usage) }
    })
})
const rankedUpstreamCount = computed(() => upstreamRows.value.filter((row) => row.rank != null).length)

const allVisibleAccountsSelected = computed(() => upstreamRows.value.length > 0 && upstreamRows.value.every((row) => selectedAccountIds.value.has(row.account.id)))
const someVisibleAccountsSelected = computed(() => upstreamRows.value.some((row) => selectedAccountIds.value.has(row.account.id)))

function toggleAccountSelection(accountId: CostAccountId) {
  const next = new Set(selectedAccountIds.value)
  if (next.has(accountId)) next.delete(accountId)
  else next.add(accountId)
  selectedAccountIds.value = next
}

function toggleSelectAllVisible() {
  const next = new Set(selectedAccountIds.value)
  if (allVisibleAccountsSelected.value) upstreamRows.value.forEach((row) => next.delete(row.account.id))
  else upstreamRows.value.forEach((row) => next.add(row.account.id))
  selectedAccountIds.value = next
}

function clearSelection() {
  selectedAccountIds.value = new Set()
}

function openBulkCostProfile() {
  const first = upstreamRows.value.find((row) => selectedAccountIds.value.has(row.account.id))
  if (!first) return
  bulkCostEdit.value = true
  selectedAccount.value = first.account
}

function closeCostProfileInspector() {
  selectedAccount.value = null
  bulkCostEdit.value = false
}

const accountPoolProviderTabs = computed(() => buildAccountPoolProviderTabs(accounts.value))
const oauthAccounts = computed(() => accountLedgers.value.filter((row) => !row.isHistorical && isCurrentAccount(row.account) && matchesAccountPoolProvider(row.account, poolPlatform.value)))
const selectedPlatformLabel = computed(() => poolPlatform.value === 'all'
  ? t('costCenter.text.allChannels')
  : accountPoolProviderTabs.value.find((item) => item.key === poolPlatform.value)?.label || t('costCenter.text.currentChannel'))
const defaultCostAccountCount = computed(() => oauthAccounts.value.filter(row => isDefaultSubscriptionCostProfile(row.account) && (row.financial.estimated || row.financial.rateEstimated)).length)
const oauthImpairmentCny = computed(() => hasMeasuredData(sourceStates.value.costLoss) || recordedLossReady.value ? poolFinancialRows.value.reduce((sum, row) => sum + row.windowLossCny, 0) : null)
const oauthHourlyCny = computed(() => poolOperatingSummary.value.fixedHourlyCny.total)
function sourceCostSummary(rows: OperatingAccount[]): AmountSummary {
  const value = summarizeKnownAmounts(rows.map(row => row.meteredCostUsd))
  value.knownSubtotal += rows.filter(row => row.meteredCostUsd == null).reduce((sum, row) => sum + (row.knownMeteredCostUsd ?? 0), 0)
  return value
}
const oauthWindowCostSummary = computed(() => sourceCostSummary(poolOperatingRows.value))
const oauthWindowOutputSummary = computed(() => operatingOutput(poolOperatingSummary.value))
const oauthRequests = computed<number | null>(() => operatingUsageReady.value ? poolOperatingRows.value.reduce((sum, row) => sum + (operatingUsageForId(row.accountId)?.requests ?? 0), 0) : null)
const oauthTokens = computed<number | null>(() => !operatingUsageReady.value ? null : summarizeKnownAmounts(poolOperatingRows.value.map(row => operatingUsageForId(row.accountId)?.tokens ?? (operatingUsageComplete.value ? 0 : null))).total)
const poolTodayOutputSummary = computed(() => hasMeasuredData(sourceStates.value.todayStats)
  ? summarizeKnownAmounts(poolOperatingRows.value.map(row => { const usage = data.todayStats.value[row.accountId]; return usage ? connectionType.value === 'sub2api' ? finiteOrNull(usage.user_cost) : finiteOrNull(usage.standard_cost) : 0 }))
  : { total: null, knownSubtotal: 0, unknownCount: 1 })
const oauthRemainingForecastUsd = computed(() => poolTodayOutputSummary.value.total == null ? null
  : Math.max(0, poolTodayOutputSummary.value.total / localForecastDay.value.elapsed * localForecastDay.value.remaining))
const oauthProcurementBaseline = computed(() => hasMeasuredData(sourceStates.value.accounts) ? financialTrend.value.map(() => oauthHourlyCny.value) : [])
const currentPoolStartedAtLabel = computed(() => {
  if (!hasMeasuredData(sourceStates.value.accounts)) return t('costCenter.text.noData')
  const timestamps = oauthAccounts.value
    .map((row) => new Date(row.account.created_at).getTime())
    .filter(Number.isFinite)
  if (!timestamps.length) return t('costCenter.text.noCurrentAccounts')
  return formatDateByLocale(new Date(Math.min(...timestamps)), {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
})
const oauthActiveCount = computed<number | null>(() => operatingUsageReady.value ? poolOperatingRows.value.filter(row => !row.isUnattributedUsage && (operatingUsageForId(row.accountId)?.requests ?? 0) > 0).length : null)
const oauthNormalCount = computed(() => oauthAccounts.value.filter((row) => currentAccountState(row.account).state === 'normal').length)
const oauthLimitedCount = computed(() => oauthAccounts.value.filter((row) => currentAccountState(row.account).limited === 1).length)
const oauthErrorCount = computed(() => oauthAccounts.value.filter((row) => currentAccountState(row.account).error === 1).length)
/** cliproxy 号池健康度:基于 auth-files 真实 status(disabled/inactive, unavailable/error, active/normal)。 */
const cliproxyHealthSummary = computed(() => {
    const rows = oauthAccounts.value
    return {
      total: rows.length,
      normal: rows.filter((row) => currentAccountState(row.account).state === 'normal').length,
      inactive: rows.filter((row) => currentAccountState(row.account).state === 'inactive').length,
      error: rows.filter((row) => currentAccountState(row.account).error === 1).length,
    }
})
/** 真实推理档位行(排除"未记录档位"那一行 —— 它不是一个档位)。 */
const cliproxyReasoningEffortTiers = computed(() => (data.cliproxyReasoningEfforts.value ?? []).filter((r) => !r.isUnrecorded))
/** 上游未记录档位的单独计数;没有就返回 null(不落 0)。 */
const cliproxyReasoningEffortUnrecorded = computed(() => (data.cliproxyReasoningEfforts.value ?? []).find((r) => r.isUnrecorded) ?? null)
const oauthUnverifiedCount = computed(() => oauthAccounts.value.filter((row) => probes.value[String(row.account.id)]?.success == null).length)
/**
 * **能不能主动探测上游** —— 三源里只有两个能(2026-09-22)。
 *
 * - sub2api:`runProbe` → `data.probeAccount` 打真实上游(adminAPI.testAccount),账号 id 就是 sub2api 的 id;
 * - cliproxy:`runProbe` 走 CPA **历史**延迟,刻意不调 adminAPI(对 cliproxy 的 FNV-1a 账号 id 会 404);
 * - **cockpit:本地用量采集源,没有探测通道。**
 *
 * 所以「N 个未主动探测」对 cockpit 是**结构性做不到**,不是「还没做」——
 * 与「源不支持采样 ≠ 待采样」同一条口径(见号池 KPI 的 `projection.*`)。
 * 此前 `:646` 的 state/note 是二态,把「非 cliproxy」一律当 sub2api,
 * 于是 cockpit 的「号池运行状态」**永久**显示 `partial` + 「N 个未主动探测」,
 * 而那个 N 恒等于账号总数(探测入口本身还挂着 `v-if="connectionType !== null"`)。
 */
const probeCapable = computed(() => connectionType.value === 'sub2api')
/** 三源键(`connectionType === null` 即 cockpit) —— 「按源取值」的**单一入口**,与 `connectionType` 三态一一对应。 */
const sourceKind = computed<'sub2api' | 'cliproxy' | 'cockpit'>(() => connectionType.value ?? 'cockpit')
/** 该源是否有探测通道的**单一措辞入口** —— 判定与措辞都在 `probeAvailabilityNote` 里(可直测)。 */
const probeNote = computed(() => probeAvailabilityNote(sourceKind.value, oauthUnverifiedCount.value))
/** 「号池运行状态」的数据状态 —— 三态判定在 `poolHealthStateFor` 里(可直测,见 `dataState.test.ts`)。 */
const poolHealthState = computed<DataAvailability>(() => poolHealthStateFor({
  source: sourceKind.value,
  cliproxyRequestTotal: oauthRequests.value ?? 0,
  unverifiedProbeCount: oauthUnverifiedCount.value,
  economicsStatus: accountEconomics.value ? sourceStates.value.economics.status : null,
  accountsStatus: sourceStates.value.accounts.status,
}))
const poolOutputProgress = computed<number | null>(() => {
  const expense = poolOperatingSummary.value.expenseCny.total
  const revenue = poolOperatingSummary.value.revenueUsd.total
  return expense != null && expense > 0 && revenue != null ? Math.max(0, revenue * exchangeRate.value.rate / expense * 100) : null
})
const economicsSampleNote = computed(() => t('costCenter.text.recordedUsageAverageHNotAStableInterval', { value0: rangeLabel.value, value1: operatingHours.value?.toFixed(2) ?? t('costCenter.text.unknown'), value2: sourceStates.value.rangeStats.status === 'partial' ? t('costCenter.text.includesUnpricedIncompleteFields') : '' }))
// A query-window average needs usage and bounds, not a remote stable-sampling extension.
const economicsDisplayState = computed<DataAvailability>(() => !operatingUsageReady.value || poolOperatingSummary.value.expenseCny.unknownCount ? 'partial' : 'estimated')
const economicsQualityLabel = computed(() => !operatingUsageReady.value ? t('costCenter.text.windowDataNotReady')
  : poolOperatingSummary.value.expenseCny.unknownCount ? t('costCenter.text.itemsMissingInformation', { value0: poolOperatingSummary.value.expenseCny.unknownCount }) : t('costCenter.text.procurementAndRateEstimatesShownSeparately'))
const economicsQualityNote = computed(() => t('costCenter.text.windowAccountsAccountsWithEnteredPurchasesMeteredRate', { value0: poolOperatingSummary.value.accountCount, value1: poolFinancialRows.value.filter(row => row.hasRecorded).length, value2: poolOperatingSummary.value.estimatedMeteredCount, value3: unassignedOperatingCount.value ? t('costCenter.text.historicalAccountsLackChannelAttribution', { value0: unassignedOperatingCount.value, value1: poolPlatform.value === 'all' ? t('costCenter.text.retainedInGlobalTotals') : t('costCenter.text.excludedFromThisChannel') }) : '' }))
const poolGroups = computed(() => {
  const groups = new Map<string, OperatingAccount[]>()
  for (const row of poolOperatingRows.value) {
    const account = operatingMetadata.value.get(row.accountId)
    const key = row.isUnattributedUsage ? 'unattributed_usage' : !account?.provider || row.billingMode === 'unknown' ? 'unassigned'
      : connectionType.value === 'cliproxy' ? account.provider
        : row.billingMode === 'metered' ? 'metered' : account.plan
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group)
  }
  return [...groups].map(([plan, rows]) => {
    const ids = new Set(rows.map(row => row.accountId))
    const current = accountLedgers.value.filter(row => !row.isHistorical && ids.has(String(row.account.id)))
    const normal = current.filter(row => currentAccountState(row.account).state === 'normal').length
    const limited = current.filter(row => currentAccountState(row.account).limited === 1).length
    const errors = current.filter(row => currentAccountState(row.account).error === 1).length
    const summary = summarizeOperatingRows(rows)
    const today = hasMeasuredData(sourceStates.value.todayStats) ? summarizeKnownAmounts(rows.map(row => {
      const usage = data.todayStats.value[row.accountId]
      return usage ? connectionType.value === 'sub2api' ? finiteOrNull(usage.user_cost) : finiteOrNull(usage.standard_cost) : 0
    })).total : null
    const dayForecastUsd = today == null ? null : today / localForecastDay.value.elapsed * localForecastDay.value.hours
    return {
      plan, planLabel: plan === 'unattributed_usage' ? t('costCenter.text.unattributedRequestsNotAccounts') : plan === 'unassigned' ? t('costCenter.text.unattributedHistoricalAccounts') : plan === 'metered' ? t('costCenter.text.meteredApi')
        : connectionType.value === 'cliproxy' ? providerLabels[plan as UpstreamProviderKey]
          : plan === 'unknown' ? t('costCenter.text.unidentifiedPlan') : plan[0].toUpperCase() + plan.slice(1),
      count: summary.accountCount, isUnattributed: plan === 'unattributed_usage', productive: operatingUsageReady.value ? rows.filter(row => !row.isUnattributedUsage && (operatingUsageForId(row.accountId)?.requests ?? 0) > 0).length : null,
      normal, limited, errors, quotaRemaining: averageQuotaRemaining(current.map(row => row.usage)),
      expenseSummary: summary.expenseCny, hourlySummary: summary.hourlyExpenseCny,
      averageExpenseSummary: scaleSummary(summary.expenseCny, summary.accountCount ? 1 / summary.accountCount : null),
      outputSummary: operatingOutput(summary), sourceCostSummary: sourceCostSummary(rows),
      requests: operatingUsageReady.value ? rows.reduce((sum, row) => sum + (operatingUsageForId(row.accountId)?.requests ?? 0), 0) : null,
      tokens: !operatingUsageReady.value ? null : summarizeKnownAmounts(rows.map(row => operatingUsageForId(row.accountId)?.tokens ?? (operatingUsageComplete.value ? 0 : null))).total,
      dayForecastUsd, monthForecastUsd: dayForecastUsd == null ? null : dayForecastUsd * new Date(now.value.getFullYear(), now.value.getMonth() + 1, 0).getDate(),
      statusRing: statusRingGradient(normal, limited, errors),
    }
  })
})

function loadVisibleUnified(window: { start: Date; end: Date }) {
  if (activePanel.value !== 'unified') return false
  void unified.loadUnified(range.value, window).catch(failure => console.warn('[unified] load failed', failure))
  return true
}
watch(activePanel, (panel) => {
  void router.replace({ query: { ...route.query, panel } })
  if (panel === 'unified' && !reloadInFlight) loadVisibleUnified(financeWindow.value)
})
// 顶部主窗口变化:模型窗口未分离时同步跟随(默认双轨同窗口,避免回到 2026-09-05 那个"模型永远 1 小时"的老问题)
watch(range, (next) => {
  if (connectionType.value === 'sub2api') data.invalidatePendingRequest()
  if (!modelWindowDetached.value && modelCostRange.value !== next) modelCostRange.value = next
  else reload()
})
watch([modelCostSource, modelCostAccountId, modelAuditMismatchOnly], () => {
  if (connectionType.value === 'sub2api') data.invalidatePendingRequest()
  reload()
})
// 模型区独立窗口:与主窗口一致 → 走普通 reload;不一致 → 只重算模型/路由(两轨互不干扰)
watch(modelCostRange, (next) => {
  if (connectionType.value === 'sub2api') data.invalidatePendingRequest()
  if (next === range.value) {
    detachModelWindow(false)
    reload()
    return
  }
  detachModelWindow(true)
  reloadModelWindow()
})
watch(refreshIntervalSeconds, (seconds) => { countdown.value = seconds })
watch(upstreamProviderTabs, (tabs) => {
  if (!tabs.some((tab) => tab.key === platformFilter.value)) platformFilter.value = 'all'
})
watch(accountPoolProviderTabs, (tabs) => {
  if (!tabs.some((tab) => tab.key === poolPlatform.value)) poolPlatform.value = 'all'
})

function normalizePanel(value: unknown): WorkspaceKey {
  const validPanels: WorkspaceKey[] = ['overview', 'upstreams', 'oauth', 'governance', 'finance', 'api', 'unified', 'cliproxy-manage']
  if (typeof value === 'string' && validPanels.includes(value as WorkspaceKey)) return value as WorkspaceKey
  // 三端连接均默认 overview(cliproxy 数据由 loadFromCliproxy 装入,cockpit/sub2api 同款)
  return 'overview'
}

function combineSourceAvailability(...states: DataSourceState[]): DataAvailability {
  if (states.some((state) => state.status === 'unavailable')) return 'unavailable'
  if (states.some((state) => state.status === 'loading')) return 'loading'
  if (states.some((state) => state.status === 'partial')) return 'partial'
  if (states.some((state) => state.status === 'stale')) return 'stale'
  if (states.some((state) => state.status === 'estimated')) return 'estimated'
  if (states.every((state) => state.status === 'empty')) return 'empty'
  return 'measured'
}
function scoreGrade(score: number): string { return score >= 82 ? 'A' : score >= 70 ? 'B' : score >= 58 ? 'C' : 'D' }
function finiteChartValue(value: unknown): number | null { const number = Number(value); return value == null || !Number.isFinite(number) ? null : number }
function divideFiniteChartValue(value: unknown, divisor: number | null): number | null { const number = finiteChartValue(value); return number == null || divisor == null || !Number.isFinite(divisor) || divisor <= 0 ? null : number / divisor }
function multiplyFiniteChartValue(value: unknown, multiplier: number): number | null { const number = finiteChartValue(value); return number == null || !Number.isFinite(multiplier) ? null : number * multiplier }
// `sumFiniteTrendValues` 已抽到 `@/features/cost-center/dataState` 由测试直测(2026-09-27):
// 「部分未知 ⇒ 已知部分之和」是语义判定,必须搬进纯函数,不能只靠视图文本扫描。
function movingAverage(values: Array<number | null>, windowSize: number): Array<number | null> { return values.map((_, index) => { const slice = values.slice(Math.max(0, index - windowSize + 1), index + 1).filter((value): value is number => value != null && Number.isFinite(value)); return slice.length ? slice.reduce((sum, value) => sum + value, 0) / slice.length : null }) }
function formatInteger(value: number | null | undefined): string { return value == null || !Number.isFinite(Number(value)) ? t('costCenter.text.noData') : formatNumberLocaleString(Math.round(Number(value))) }
function formatPercent(value: number | null | undefined): string { return value == null || !Number.isFinite(Number(value)) ? t('costCenter.text.noData') : `${(Number(value) * 100).toFixed(1)}%` }
function formatPlainNumber(value: number | null | undefined, digits = 2): string { return value == null || !Number.isFinite(Number(value)) ? t('costCenter.text.noData') : Number(value).toFixed(digits) }
function formatCny(value: number | null | undefined, digits = 2): string { return value == null || !Number.isFinite(Number(value)) ? t('costCenter.text.noData') : formatMoney(Number(value), 'CNY', digits) }
function formatUsd(value: number | null | undefined, digits = 2): string { return value == null || !Number.isFinite(Number(value)) ? t('costCenter.text.noData') : formatMoney(Number(value), 'USD', digits) }
function formatKnownAmount(value: AmountSummary, currency: 'USD' | 'CNY', digits = 4, rate = false): string {
  if (value.total == null && !value.unknownCount) return t('costCenter.text.noData')
  const amount = value.total ?? value.knownSubtotal
  return rate && amount !== 0 && Math.abs(amount) < 10 ** -digits
    ? `${amount < 0 ? '>' : '<'}${formatMoney(amount < 0 ? -(10 ** -digits) : 10 ** -digits, currency, digits)}/h`
    : `${formatMoney(amount, currency, digits)}${rate ? '/h' : ''}`
}
function amountCoverage(value: AmountSummary): string {
  return value.total == null && value.unknownCount ? t('costCenter.text.calculatedPortionMissingInformation', { value0: value.unknownCount }) : ''
}
function formatAmount(value: AmountSummary, currency: 'USD' | 'CNY', digits = 4, rate = false): string {
  const money = formatKnownAmount(value, currency, digits, rate)
  return value.total == null && value.unknownCount ? t('costCenter.text.calculatedPortionMissingInformation2', { value0: money, value1: value.unknownCount }) : money
}
function formatRate(value: number | null | undefined, currency: 'USD' | 'CNY'): string { return value == null || !Number.isFinite(value) ? t('costCenter.text.noData') : formatAmount({ total: value, knownSubtotal: value, unknownCount: 0 }, currency, 6, true) }
// FIX 8:fallbackLabel 让调用点区分「还没采样」与「源结构性不支持采样」,不再一律说「待采样」。
function formatOptionalUsd(value: number | null | undefined, digits = 2, fallbackLabel = t('costCenter.text.awaitingSamples')): string { return value == null || !Number.isFinite(Number(value)) ? fallbackLabel : formatUsd(Number(value), digits) }
function formatUsdPerMillion(value: number | null | undefined): string { return value == null || !Number.isFinite(Number(value)) ? t('costCenter.text.noData') : `${formatUsd(Number(value) * 1_000_000, 4)}/M` }
function formatDuration(value: number): string { return value > 0 ? value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms` : t('costCenter.text.noSamples') }
function formatTokens(value: number | null | undefined): string { if (value == null || !Number.isFinite(Number(value))) return t('costCenter.text.noData'); const number = Number(value); return number >= 1e9 ? `${(number / 1e9).toFixed(2)}B` : number >= 1e6 ? `${(number / 1e6).toFixed(2)}M` : number >= 1e3 ? `${(number / 1e3).toFixed(1)}K` : formatInteger(number) }
function formatCacheHitRate(inputTokens: number | null, cacheReadTokens: number | null, cacheWriteTokens: number | null = 0): string {
  if (inputTokens == null || cacheReadTokens == null || (connectionType.value === 'sub2api' && cacheWriteTokens == null)) return t('costCenter.text.cacheHitRatioUnconfirmed')
  const total = connectionType.value === 'sub2api' ? inputTokens + cacheReadTokens + (cacheWriteTokens ?? 0) : inputTokens
  return total > 0 ? t('costCenter.text.inputCacheHit', { value0: formatPercent(cacheReadTokens / total) }) : t('costCenter.text.noInputTokens')
}
// upstreamModel 为 null = 源不提供逐请求的上游模型（例如 cockpit 的 request_logs 只有 model_id）。
// 价格查找这类"需要模型名"的地方显式回退到请求模型；但**展示**上不得回退，否则会显示
// `gpt-5 → gpt-5` 暗示"实测到上游也是 gpt-5"。
function routePricingModel(row: ModelRouteRow): string { return row.upstreamModel ?? row.requestedModel }
function resolveRoutePricing(row: ModelRouteRow): ChannelModelPricing | ModelDefaultPricing | undefined { return row.channelPricing ?? modelPricing.value[routePricingModel(row)] }
function routePricingSource(row: ModelRouteRow): string { return row.channelPricing ? t('costCenter.text.customChannelPrice') : modelPricing.value[routePricingModel(row)]?.found ? connectionType.value === 'sub2api' ? t('costCenter.text.currentModelCatalog') : t('costCenter.text.localFallbackCatalogNotNecessarilyTheRequestS') : t('costCenter.text.priceNotFound') }
function formatCompactDate(value: string | number): string { const date = new Date(value); return Number.isFinite(date.getTime()) ? formatDateByLocale(date, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : t('costCenter.text.noData') }
function formatModelTime(value?: string): string { const date = new Date(value || ''); return Number.isFinite(date.getTime()) ? formatDateByLocale(date, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : t('costCenter.text.noData') }
function modelAuditStatusLabel(row: ModelRouteRow): string { return row.modelAuditStatus === 'mismatch' ? t('costCenter.text.mismatchPossibleModelSubstitution') : row.modelAuditStatus === 'matched' ? t('costCenter.text.matched') : t('costCenter.text.auditRecordMissing') }
// clampUtilization / formatUtilization / hasPrimaryUsageWindow / quotaRemainingRatio /
// averageQuotaRemaining 已移入 `@/features/cost-center/honestValues`(审查 #3/#4/#5)。
// 原实现的三处硬伤:未知利用率 `Number(null)||0` ⇒ 0% + 绿色 'high' 健康态;
// 无窗口返回 1 ⇒ "剩余 100%";无账号同步返回 0 ⇒ "余量 0.0%"(读成已耗尽)。
function formatUsageReset(value: string | null): string {
  if (!value) return t('costCenter.text.resetTimeUnknown')
  const remainingMs = new Date(value).getTime() - now.value.getTime()
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return t('costCenter.text.resetting')
  const minutes = Math.ceil(remainingMs / 60_000)
  if (minutes < 60) return t('costCenter.text.inM', { value0: minutes })
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return t('costCenter.text.inHM', { value0: hours, value1: restMinutes })
  return t('costCenter.text.inDH', { value0: Math.floor(hours / 24), value1: hours % 24 })
}
function formatTrendLabel(value: string): string { const date = parseTrendDate(value); return Number.isFinite(date.getTime()) ? formatDateByLocale(date, range.value === '7d' || range.value === '30d' ? { month: '2-digit', day: '2-digit' } : { hour: '2-digit', minute: '2-digit' }) : value }
function donutGradient(items: Array<{ value: number; color: string }>): string { const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0); if (!total) return 'conic-gradient(#303830 0 100%)'; let cursor = 0; const stops = items.map((item) => { const start = cursor; cursor += Math.max(0, item.value) / total * 100; return `${item.color} ${start}% ${cursor}%` }); return `conic-gradient(${stops.join(', ')})` }
function statusRingGradient(normal: number, limited: number, errors: number): string { const total = Math.max(1, normal + limited + errors); const normalEnd = normal / total * 100; const limitedEnd = normalEnd + limited / total * 100; return `conic-gradient(#b9e55a 0 ${normalEnd}%, #9c8a54 ${normalEnd}% ${limitedEnd}%, #995c50 ${limitedEnd}% 100%)` }
let reloadQueued = false
let reloadInFlight = false
async function reload(background = false) {
  if (reloadInFlight || loading.value) {
    reloadQueued = true
    return
  }
  reloadInFlight = true
  fullscreenFailure.value = null
  refreshing.value = true
  let unifiedReadStarted = false
  try {
  do {
    reloadQueued = false
    let summaryWindow = usageWindowBounds(range.value)
    summaryWindow.end = new Date(Math.min(Date.now(), summaryWindow.end.getTime()))
    if (connectionType.value !== 'sub2api') await data.preloadLocalCostProfiles()
    // 按连接类型分流:sub2api 调完整 adminAPI;cliproxy/cockpit 只调对应数据源 + unified
    if (connectionType.value === 'sub2api') {
      await data.reload(range.value, { background })
      const connection = data.sub2apiWindowConnection.value
      const reading = data.sub2apiWindowReading.value
      if (connection && reading) unified.setSub2apiData(connection, reading)
      summaryWindow = data.sub2apiRequestWindow.value ?? summaryWindow
    } else if (connectionType.value === 'cliproxy') {
      // cliproxy 复用 sub2api 同套深色模板:CPA 插件 usage_events + model_prices 适配进 store
      // 混合数据源:management API(账号实体/配置/版本) + CPA events(成本/时序/配额),按 auth_index 关联。
      // 账号 = /auth-files 真实实体(email/provider/status),替代 CPA auth_index 聚合。
      // 成本/时序/配额 = CPA events × model_prices(唯一成本源)。
      // 单次并行请求所有 management API + CPA 数据(消除 overview/reload 重复请求)
      // 不调 getLatestVersion(查 GitHub 限流返 502),version 从 config 或留空
      // /auth-files 读取失败必须与「确实一个认证文件都没有」区分开:前者置 null(显示「无数据」+
      // unavailable),后者是合法的 0(仍挂 measured)。原实现把失败 catch 成空数组,
      // 于是 authFiles.length === 0 被当成实测零 —— 红线禁止的假零。
      let authFilesFailed = false
      cliproxyAuthFileFailure.value = null
      let cpaReadError: { detail: string } | null = null
      const [authFiles, config, keyUsage, usageSnapshot, prices, dbg, strategy] = await Promise.all([
        getAuthFiles().catch((failure) => { authFilesFailed = true; cliproxyAuthFileFailure.value = { detail: errMsg(failure, '') }; return [] as AuthFile[] }),
        getConfig().catch(() => null),
        getApiKeyUsage().catch(() => ({} as Record<string, Record<string, ApiKeyUsageBucket>>)),
        getCliproxyUsageSnapshot().catch((failure): CliproxyUsageSnapshot => {
          cpaReadError = { detail: errMsg(failure, '') }
          return { available: false, events: [], readStartMs: null, readEndMs: null }
        }),
        getCliproxyModelPrices().catch(() => ({} as Record<string, LitellmPricing>)),
        getDebug().catch(() => null),
        getRoutingStrategy().catch(() => null),
      ])
      const events = usageSnapshot.events
      const batchAnchor = new Date(usageSnapshot.readEndMs ?? Date.now())
      summaryWindow = usageWindowBounds(range.value, batchAnchor)
      summaryWindow.end = new Date(Math.min(batchAnchor.getTime(), summaryWindow.end.getTime()))
      // 构建 overview(供 API tab/version/authFileCount/routingStrategy/debug)
      cliproxyOverview.value = {
        version: null,
        authFileCount: authFilesFailed ? null : authFiles.length,
        routingStrategy: strategy,
        // getScalar 在 CPA config 缺 debug key 时返 undefined,读取失败已归一为 null ——
        // 两者都必须渲染 —,不得渲染成「关闭」(那是我们并不掌握的事实)。
        debug: typeof dbg === 'boolean' ? dbg : null,
      }
      // 注入 CPA 数据给 unified,避免 loadCliproxy 内部重复请求 SQLite
      unified.setCliproxyData(events, prices, usageSnapshot)
      // 汇率:cliproxy 分支不走通用 reload,需独立请求网络实时汇率(override>cache>网络>兜底6.8)
      // 更新 exchangeRate.value 后传入 loadFromCliproxy 算 economics,保证显示与计算口径一致
      exchangeRate.value = await loadUsdCnyExchangeRate()
      // 两个窗口分开传:range=顶部主窗口(trend/ops/账号/采购),modelCostRange=模型区独立窗口
      // (models 表 + modelRoutes 路由明细表)。cliproxy 没有接口,这两张表由 store 本地按窗口过滤。
      data.loadFromCliproxy(authFiles, config, cliproxyOverview.value?.version ?? null, events, prices, keyUsage, range.value, modelCostRange.value, exchangeRate.value.rate, batchAnchor, usageSnapshot.available, authFilesFailed ? () => cliproxyAuthFileError.value : null)
      if (authFilesFailed && data.cliproxyManagementSnapshotAt.value && cliproxyOverview.value) cliproxyOverview.value.authFileCount = data.cliproxyAuthFiles.value.length
      if (!usageSnapshot.available) {
        for (const key of ['dashboard', 'todayStats', 'rangeStats', 'models', 'ops', 'modelRoutes', 'modelAudit', 'economics'] as const) {
          sourceStates.value[key] = sourceState(key, 'unavailable', () => cpaReadError ? cpaReadError.detail || t('costCenter.text.failedToReadCpaUsageDatabase') : t('costCenter.text.cpaUsageDatabaseMissingCannotTreatUsageAs'))
        }
      }
      await data.mergeLocalCostProfiles() // cliproxy 同样支持本地 cost_profile 回填
    } else if (connectionType.value === null) {
      // cockpit 复用 sub2api 同套深色模板:先装本地数据进 store(驱动 modelCostRows/upstreamRows/financialTrend 等 computed),
      // 再读本地访问配置(api tab 用) + 配额历史(accountUsage) + 路由日志(modelRoutes)。
      // range 切换时 loadFromCockpit 按 range 取对应时序窗口。
      // 汇率:cockpit 分支不走通用 reload,需独立请求网络实时汇率(与 cliproxy 同理)
      exchangeRate.value = await loadUsdCnyExchangeRate()
      await loadCockpitOverview()
      // 用量台账(cockpit 移除 API 会清数据、重加从 0 计数——成本端不能丢):
      // 快照当前用量(含孤儿) + 回填被清零的回归账号 + 注入 stats 已消失的账号,
      // 再持久化合并结果。台账读失败(旧版宿主/非桌面)返 null → 跳过合并,主流程不受影响。
      if (cockpitStats.value) {
        const ledger = await readCostLedger()
        const mergedLedger = applyCockpitUsageLedger(cockpitStats.value, ledger?.accounts ?? null)
        await writeCostLedger(mergedLedger)
      }
      // 并行读配额历史 + apikey 渠道信息(名+baseUrl)。
      // 当天路由日志(实测 40MB+)不再无条件读:只有 Rust 聚合缺项(分钟级窗口/聚合失败)
      // 需要回退时才读,避免每次切窗口都往 WebView 塞进几十 MB 字符串。
      const [quotaHistories, apiKeyInfos] = await Promise.all([
        getCockpitQuotaHistories(),
        getCockpitApiKeyNames(),
      ])
      cockpitQuotaHistories.value = quotaHistories
      let apiLog: string | null = null
      if (cockpitStats.value) {
        // apikey 账号 accountId → {渠道名, baseUrl} Map(codex_model_providers.json)
        const apiKeyInfoMap = new Map(apiKeyInfos.map((m) => [m.accountId, { name: m.name, baseUrl: m.baseUrl }]))
        // 多平台账号清单(gemini/antigravity/claude/cursor/kiro):cockpit 上游只产 codex 的 token 级用量,
        // 这些平台有账号、有配额——按 P0-19 三态标 usage_granularity(quota_level / unavailable),
        // 不再用已废弃的 cockpit_platform_no_usage(它基于"非 codex 无用量"这个被推翻的结论)。
        // cursor/kiro 无对应平台枚举,按 cockpitPlatformOf 同约定归 openai;antigravity 无 plan 数据不编造。
        const platformInputs: CockpitPlatformAccountInput[] = [
          ...cockpitGeminiAccounts.value.map((a) => ({ id: a.id, email: a.email, planLabel: a.plan_name, createdAt: a.created_at, lastUsed: a.last_used, platform: 'gemini' as const })),
          ...cockpitAntigravityAccounts.value.map((a) => ({ id: a.id, email: a.email, createdAt: a.created_at, lastUsed: a.last_used, platform: 'antigravity' as const })),
          ...cockpitClaudeAccounts.value.map((a) => ({ id: a.id, email: a.email, planLabel: a.plan_name, planType: a.plan_type, createdAt: a.created_at, lastUsed: a.last_used, platform: 'anthropic' as const })),
          ...cockpitCursorAccounts.value.map((a) => ({ id: a.id, email: a.email, planLabel: a.plan_name, planType: a.plan_type, createdAt: a.created_at, lastUsed: a.last_used, platform: 'openai' as const })),
          ...cockpitKiroAccounts.value.map((a) => ({ id: a.id, email: a.email, planLabel: a.plan_name, planType: a.plan_type, createdAt: a.created_at, lastUsed: a.last_used, platform: 'openai' as const })),
        ]
        // Rust 侧多天日志聚合:所有窗口都走(日志文件范围=窗口端点日期,请求再按精确 ms 窗口过滤),
        // 分桶结果为空(分钟级窗口)时由 loadFromCockpit 回退当天日志解析。
        let multiDayOps: OpsThroughputTrendPoint[] | null = null
        // 2026-09-05 修复"7d/30d 数据是错的":快照 weekly/monthly 是日历累计(本周一/本月1日起),
        // 冒充滚动窗口后 7d(8/31 起 5 天)$2,464 反而大于 30d(9/1 起 4 天)$1,141。
        // 请求数改用日志 per-account 聚合的真实滚动窗口;成本/Token 保持快照并由列标注真实口径。
        let multiDayAccountRequests: Record<string, number> | null = null
        // Rust 侧多天日志的路由聚合(模型×账号×入站接口):修复"真实模型/渠道/接口明细
        // 切窗口不变"——该表此前固定读当天 codex-api.log,7d/30d 与 today 出同一份数据。
        let multiDayRoutes: CockpitOpsRouteAgg[] | null = null
        // 2026-09-06 修复"24h 窗口丢昨天数据":此前只有 7d/30d 走 Rust 多天聚合,
        // 24h/6h 仍用**当天**日志(只覆盖今天 00:00 之后),滚动窗口跨天时昨天的数据全丢。
        // 6h/24h 一并接入 Rust 聚合(bucket_hours 最小 1 小时),再按精确窗口裁剪桶。
        // today/1h 也走聚合(1 天文件 + 精确 ms 窗口),保证路由明细与趋势同口径。
        // 桶尺寸:7d/30d 用天桶,其余用 1 小时桶(Rust bucket_hours 最小 1)
        const bucketHours = range.value === '7d' || range.value === '30d' ? 24 : 1
        // 单请求用量库(codex_local_access_logs.sqlite)按观察窗口聚合。
        // 这是 cockpit 成本能算准的关键:长上下文档位价按**单请求** input_tokens > 272_000 判定,
        // 而 stats JSON 只有日历累计快照、codex-api 日志没有 token 字段——不读这库就只能
        // 拿"窗口平均 token"猜档,实测 gpt-6-astra 成本会少算近一半。
        let requestLog: CockpitRequestLogSummary | null = null
        const costQueryWindow = summaryWindow
        // 今日另取一份自然日窗口(观察窗口是 7d/30d 时,"今日"不能跟着变成 7 天累计)
        let todayRequestLog: CockpitRequestLogSummary | null = null
        // FIX 5:Rust summarize_cockpit_api_logs 顶层新增的窗口级 TTFT 分位数。
        // 两个分位数都缺 = 窗口内无首 token 样本 ⇒ null,面板继续显示「无样本」,绝不落成 0。
        let cockpitWindowTtft: { p50Ms: number | null; p95Ms: number | null } | null = null
        {
          // 日志文件范围直接取窗口端点日期(而非"N 天前 00:00"):1h 窗口跨午夜时
          // 必须读昨天的文件,否则窗口起点那段请求会丢。
          const bounds = costQueryWindow
          const summary = await getCockpitOpsSummary(
            cockpitLocalDate(bounds.start),
            cockpitLocalDate(bounds.end),
            bucketHours,
            bounds.start.getTime(),
            bounds.end.getTime(),
          )
          // FIX 5:窗口级 TTFT(可选字段,旧版 Rust 不返回时为 undefined ⇒ 保持 null)。
          cockpitWindowTtft = summary && (summary.ttft_p50_ms != null || summary.ttft_p95_ms != null)
            ? { p50Ms: summary.ttft_p50_ms ?? null, p95Ms: summary.ttft_p95_ms ?? null }
            : null
          if (summary?.buckets.length) {
            multiDayOps = clipOpsBucketsToWindow(cockpitOpsSummaryToTrend(summary, bucketHours), range.value)
            multiDayAccountRequests = cockpitOpsAccountsToRequestCounts(summary.accounts ?? [])
            cockpitLogWindowRange.value = summary.min_date && summary.max_date
              ? { min: summary.min_date, max: summary.max_date }
              : null
          } else {
            cockpitLogWindowRange.value = null
          }
          // 路由聚合与桶相互独立:即使该窗口没有桶(请求稀疏)也可能有路由行
          multiDayRoutes = summary?.routes?.length ? summary.routes : null
          // 回退才读当天日志(趋势桶或路由聚合缺项时)
          if (!multiDayOps || !multiDayRoutes) {
            apiLog = await getCockpitApiLog()
          }
          cockpitApiLog.value = apiLog
        }
        {
          requestLog = await getCockpitRequestLogSummary(bucketHours, costQueryWindow.start.getTime(), costQueryWindow.end.getTime())
          if (range.value === 'today') {
            todayRequestLog = requestLog
          } else {
            const todayBounds = usageWindowBounds('today', costQueryWindow.end)
            todayBounds.end = costQueryWindow.end
            todayRequestLog = await getCockpitRequestLogSummary(bucketHours, todayBounds.start.getTime(), todayBounds.end.getTime())
          }
          if (requestLog && !requestLog.available) {
            console.warn(t('costCenter.text.cockpitPerRequestUsageDatabaseUnavailableCostsFall'), requestLog.reason)
          }
        }
        // 累计(全量,不限观察窗口)口径:账号表/密钥表/模型定价表用。
        // includeCells=false —— 这些表只要汇总,不要时间桶(省约一半扫描开销)。
        {
          const cumulative = await getCockpitRequestLogSummary(1, null, null, false)
          const sets = cockpitEffectivePriceSets(cockpitLocalAccess.value?.modelPricings)
          if (cumulative?.available && cumulative.groups?.length) {
            // 逐账号:key 用 cockpit 原始 accountId(三端汇总按原文匹配)
            const byAccount: Record<string, number> = {}
            // ★ 逐账号的「最差计价依据」(2026-09-23):逐账号合计同样是**求和**,
            //   算不出来的组贡献哨兵 0 ⇒ 只要有组算不出来,该账号的合计就只是**下界**。
            //   只算全局那一份是不够的 —— 账号表是**另一个消费点**,漏了它就会出现
            //   「总额标注了下界、而账号行显示成实测金额」(修一处漏一处的老毛病)。
            const byAccountBasis: Record<string, CostBasisKind> = {}
            const byModel: Record<string, number> = {}
            const byModelBasis: Record<string, CostBasisKind> = {}
            let worstBasis: CostBasisKind | undefined
            for (const g of cumulative.groups) {
              const priced = cockpitSplitCostUsd(g, cockpitPriceSetFor(sets, g.model), data.cockpitCostMultiplier.value)
              const costBasis = priced.costBasis
              const cost = costBasis.kind === 'no_price_no_estimate' ? priced.knownCostUsd ?? 0 : priced.cost
              if (g.accountId) {
                byAccount[g.accountId] = (byAccount[g.accountId] ?? 0) + cost
                byAccountBasis[g.accountId] = worseBasisOf(byAccountBasis[g.accountId], costBasis.kind)
              }
              byModel[g.model] = (byModel[g.model] ?? 0) + cost
              byModelBasis[g.model] = worseBasisOf(byModelBasis[g.model], costBasis.kind)
              // 逐组取"更差一侧":只要有组算不出来,下面那个总和就只是**下界**。
              worstBasis = worstCostBasisKind(worstBasis, costBasis.kind)
            }
            cockpitCumulativeAccountCost.value = byAccount
            cockpitCumulativeAccountBasis.value = byAccountBasis
            cockpitCumulativeModelCost.value = byModel
            cockpitCumulativeModelBasis.value = byModelBasis
            cockpitCumulativeTotalUsd.value = Object.values(byModel).reduce((a, b) => a + b, 0)
            cockpitCumulativeCostBasis.value = worstBasis ?? null
            // ★ 数据源实际覆盖范围(全表 min/max)。这次扫描 start_ms/end_ms 都传 null ⇒
            //   返回的就是全表边界,正是判定「窗口是否被源覆盖」需要的那份事实。
            cockpitDataSourceRange.value = { startMs: cumulative.windowStartMs, endMs: cumulative.windowEndMs }
            cockpitCumulativeApiKey.value = cockpitRequestLogToApiKeyStats(cumulative, sets, data.cockpitCostMultiplier.value)
          } else {
            cockpitCumulativeAccountCost.value = null
            cockpitCumulativeAccountBasis.value = null
            cockpitCumulativeModelCost.value = null
            cockpitCumulativeModelBasis.value = null
            cockpitCumulativeApiKey.value = null
            cockpitCumulativeTotalUsd.value = null
            cockpitCumulativeCostBasis.value = null
            // 库不可用 ⇒ 覆盖范围未知(不是"覆盖为 0"),由 cockpitWindowCoverage 判成 unknown,
            // 标注退回窗口名本身 —— 不猜,也不谎报「全程覆盖」。
            cockpitDataSourceRange.value = { startMs: null, endMs: null }
          }
        }
        await data.loadFromCockpit(cockpitStats.value, cockpitLocalAccess.value, range.value, quotaHistories, apiLog, apiKeyInfoMap, new Map(cockpitCodexAccounts.value.map((a) => [a.id, a])), platformInputs, multiDayOps, multiDayAccountRequests, multiDayRoutes, requestLog, todayRequestLog, cockpitGroupNameMap.value, cockpitWindowTtft, costQueryWindow)
        if (modelWindowDetached.value && modelCostRange.value !== range.value) await reloadModelWindow()
        // 装完 accounts 后回填本地 cost_profile(cockpit 无后端,手动配置存本地 JSON,reload 不丢)
        await data.mergeLocalCostProfiles()
        // ★ 账本持久化(2026-09-12):二期 Rust 的 ledger_ingest 此前**全仓零调用**,
        //   于是 cost_ledger.sqlite 从未落盘——cockpit 自己轮转/重建时历史就跟着丢了。
        //   这里在 cockpit 数据装好后**后台触发一次**(fire-and-forget,不阻塞首屏):
        //   首次全量扫两源合计约 41 万行需数秒到数十秒,之后按 `ingest_state` 水位增量,开销极小;
        //   重复触发由 Rust `INGEST_LOCK` 让路 + 水位幂等兜底。
        //   2026-09-12 起一轮会顺序摄取**全部已知源**(codex_logs + codex_sessions),
        //   结果逐源返回,UI 不许合并成一句"成功"。
        ledgerIngestOnce((result) => {
          ledgerIngestState.value = result
          const allDown = ledgerAllUnavailableReason(result)
          if (allDown) {
            console.warn(t('costCenter.text.ledgerAllSourcesUnavailable'), allDown)
          }
          for (const s of result?.sources ?? []) {
            if (!s.sourceAvailable || !s.ok) {
              console.warn(t('costCenter.text.ledgerSourceNotReady', { value0: s.sourceName || s.label }), s.reason)
            }
          }
          // 摄取结束后再读多源对账(P0-25):账本这时才含本轮数据。
          void loadLedgerReconcile()
        })
        // 渠道配额(P0-21):只探测有账号的渠道并读落盘快照(路径 B,零外网请求)。
        // 会话内只加载一次 —— 快照本身有 60s/300s TTL,切窗口不必重读。
        if (!quotaLoaded.value) {
          void loadChannelQuota()
          // 「当前账号」+「模型分组」:与配额同批拉,失败各自吞掉(UI 显示 —)。
          void loadCockpitAccountMeta()
        }
        // request_logs 未读维度(缺口 ③):失败全量分类 + 单价快照对账 + 推理档位 + 网关通道。
        // 与上面的 17.9 万行聚合相互独立,单独失败不影响成本主链路。
        void loadRequestLogFacets(costQueryWindow)
        // P0-25 多源对账:必须在**摄取完成之后**读,否则账本里还没有这一轮的数据。
        // 故放在上方 ledgerIngestOnce 的回调里触发(见该回调),这里不重复调用。
        if (reconcileLoaded.value) {
          // 已读过则按新窗口刷新一次(切窗口时对账明细不必重读,但源清单要更新水位)
          void loadLedgerReconcile()
        }
      } else {
        // D6:cockpit 未安装 / codex_local_access_stats.json 缺失(getCockpitStats() 返 null)时,
        // 上面整段被跳过 → store 会保留**上一连接源**(sub2api/cliproxy)的
        // accounts/todayStats/models/trend/accountUsage/opsOverview/modelRoutes…,
        // 而 connectionType === null 让所有文案都标成「cockpit …」= 用 cockpit 的文案渲染别端的数字。
        // 显式清空并把相关 sourceStates 置 unavailable。顺带收尾 loading:
        // 只有 loadFromCockpit 末尾会把它置回 false,跳过它必须自己置,否则 reload() 因 loading
        // 恒真而永久早退,页面卡在加载态。
        data.clearCockpitSourceData(t('costCenter.text.cockpitNotInstalledOrCodexLocalAccessStats'))
      }
    }
    if (!reloadQueued) unifiedReadStarted = loadVisibleUnified(summaryWindow)
  } while (reloadQueued)
  } finally {
    reloadInFlight = false
    refreshing.value = false
    countdown.value = refreshIntervalSeconds.value
    if (!unifiedReadStarted) loadVisibleUnified(financeWindow.value)
  }
}
/** 用户手动设置汇率(写 override,最高优先级,网络失败时不走 7.2 fallback)。改后即时 reload 重算。 */
function handleRateOverride(event: Event) {
  const target = event.target as HTMLInputElement
  const rate = Number(target.value)
  if (saveUserOverrideRate(rate)) {
    exchangeRate.value = { rate, rateDate: null, fetchedAt: null, source: 'override' }
    appStore.showSuccess(t('costCenter.text.exchangeRateSetToCnyUsdManualOverride', { value0: rate }))
    reload(true) // 即时用新汇率重算所有成本
  } else {
    appStore.showError(t('costCenter.text.invalidExchangeRateNumberFrom4To10'))
  }
}
function clearRateOverride() {
  clearUserOverrideRate()
  appStore.showInfo(t('costCenter.text.automaticExchangeRateRestoredRefreshing'))
  reload(true)
}

/**
 * 模型区**独立窗口**取数(2026-09-10 双轨)。
 * 只重算模型成本表与路由明细,不触碰主窗口的 trend/ops/账号/采购数据——
 * 用户把模型区切到 7 天时,顶部仍是 1 小时,两轨各算各的。
 * cockpit 源走 SQLite 单请求库 + Rust 日志路由聚合;
 * sub2api 由接口按 modelCostRange 传窗口;
 * cliproxy 没有接口 —— 模型表与路由明细由 loadFromCliproxy 的 modelRange 在本地按 requested_at 过滤。
 */
async function reloadModelWindow() {
  const generation = ++modelWindowGeneration
  const modelRange = modelCostRange.value
  const source = connectionType.value
  const current = () => generation === modelWindowGeneration && modelCostRange.value === modelRange && connectionType.value === source && modelRange !== range.value
  modelWindowReadFailed.value = false
  if (modelRange === range.value) { reload(); return }
  if (connectionType.value !== null) { reload(); return } // sub2api:接口按 modelCostRange 传窗口;cliproxy:store 按 modelRange 本地过滤
  if (!isTauriDesktop) { reload(); return }
  try {
    const bucketHours = modelRange === '7d' || modelRange === '30d' ? 24 : 1
    const bounds = usageWindowBounds(modelRange)
    const [opsSummary, requestLog] = await Promise.all([
      getCockpitOpsSummary(
        cockpitLocalDate(bounds.start),
        cockpitLocalDate(bounds.end),
        bucketHours,
        bounds.start.getTime(),
        bounds.end.getTime(),
      ),
      getCockpitRequestLogSummary(bucketHours, bounds.start.getTime(), bounds.end.getTime(), false),
    ])
    if (!current()) return
    loadCockpitModelWindow(requestLog, opsSummary?.routes?.length ? opsSummary.routes : null, modelRange)
  } catch (e) {
    if (!current()) return
    console.warn(t('costCenter.text.cockpitIndependentModelWindowFetchFailedFallingBack'), e)
    loadCockpitModelWindow(null, null, modelRange)
    const snapshot = cockpitStats.value && modelCostAccountId.value == null ? cockpitWindowForRange(cockpitStats.value, modelRange) : undefined
    const hasSnapshot = Array.isArray(snapshot?.models)
    const detail = e instanceof Error ? e.message : String(e)
    sourceStates.value.models = sourceState('models', hasSnapshot ? 'partial' : 'unavailable', () => t(hasSnapshot ? 'costCenter.integration.modelCalendarFallback' : 'costCenter.integration.modelWindowUnavailable', {
      window: cockpitStats.value ? cockpitWindowLabelForRange(cockpitStats.value, modelRange) : '', detail,
    }), null)
    sourceStates.value.modelRoutes = sourceState('modelRoutes', 'unavailable', () => t('costCenter.integration.modelRoutesUnavailable', { detail }), null)
    modelWindowReadFailed.value = true
  }
}

/** cockpit 倍率设置：保存后即时 reload 重算。 */
async function handleMultiplierOverride(event: Event) {
  const target = event.target as HTMLInputElement
  const mult = Number(target.value)
  if (!Number.isFinite(mult) || mult < 0.1 || mult > 10) {
    appStore.showError(t('costCenter.text.invalidMultiplierNumberFrom01To10'))
    return
  }
  await data.saveCockpitCostMultiplier(mult)
  appStore.showSuccess(t('costCenter.text.costMultiplierSetToRecalculating', { value0: mult }))
  reload(true)
}
async function refreshPricingCatalog() {
  if (connectionType.value !== 'sub2api') {
    await loadLocalCatalog(true)
    if (!localCatalogError.value) await reload(true)
    return
  }
  if (pricingRefreshing.value) return
  try {
    const status = await data.refreshPricingCatalog()

    appStore.showSuccess(t('costCenter.text.priceCatalogSynchronizedWithModelsNewPricesApply', { value0: formatInteger(status.model_count) }))
  } catch (refreshError: any) {
    appStore.showError(t('costCenter.text.priceCatalogSynchronizationFailed', { value0: refreshError?.message || t('costCenter.text.remoteInterfaceUnavailable') }))
  }
}
function toggleAutoRefresh() { autoRefresh.value = !autoRefresh.value; countdown.value = refreshIntervalSeconds.value }
function goToAccounts() { router.push('/admin/accounts') }
function openSub2APISettings() { router.push('/admin/settings') }
async function runProbe(account: Account) {
  if (probes.value[String(account.id)]?.loading) return
  // cliproxy 用 CPA 历史 latency(真实采集),不调 adminAPI.testAccount(对 cliproxy 账号 id 404)
  if (connectionType.value === 'cliproxy') {
    const lat = data.cliproxyLatencyMap.value[String(account.id)]
    if (lat != null) appStore.showSuccess(t('costCenter.text.cpaHistoricalLatencyMs', { value0: account.name, value1: formatInteger(lat) }))
    else appStore.showInfo(t('costCenter.text.hasNoCpaLatencyData', { value0: account.name }))
    return
  }
  appStore.showInfo(t('costCenter.text.testingOneRealMinimalRequestWillBeSent', { value0: account.name }), 2500)
  try {
    const result = await data.probeAccount(account)
    if (result.success) {
      // 探测成功但耗时缺失 ⇒ 省略耗时片段。`latency_ms || 0` 会报出"总耗时 0 ms" =
      // 断言"瞬时返回",而我们其实没拿到耗时。
      const latency = latencySampleMs(result.latency_ms)
      appStore.showSuccess(latency == null
        ? t('costCenter.text.connectionTestComplete', { value0: account.name })
        : t('costCenter.text.connectionTestCompleteTotalDurationMs', { value0: account.name, value1: formatInteger(latency) }))
    } else appStore.showError(t('costCenter.text.testFailed', { value0: account.name, value1: result.message }))
  } catch (probeError: any) {
    appStore.showError(t('costCenter.text.testForFailed', { value0: account.name, value1: probeError?.message || t('costCenter.text.requestError') }))
  }
}
async function saveSelectedCostProfile(profile: CostProfile) {
  if (!selectedAccount.value) return
  try {
    // cockpit 模式无 sub2api 后端,成本档案写本地 JSON(cockpit_cost_profiles.json)
    if (connectionType.value !== 'sub2api') {
      if (bulkCostEdit.value) {
        const ids = [...selectedAccountIds.value]
        await data.bulkSaveCockpitCostProfile(ids, profile)
        appStore.showSuccess(t('costCenter.text.savedCostSettingsForAccounts', { value0: ids.length }))
        clearSelection()
        closeCostProfileInspector()
        if (connectionType.value === 'cliproxy') await data.loadAccountEconomics('all', range.value)
        return
      }
      const updated = await data.saveCockpitCostProfile(selectedAccount.value, profile)
      selectedAccount.value = updated
      if (connectionType.value === 'cliproxy') await data.loadAccountEconomics('all', range.value)
      appStore.showSuccess(t('costCenter.text.costSettingsSavedCumulativeCostRecalculated'))
      return
    }
    if (bulkCostEdit.value) {
      const ids = [...selectedAccountIds.value]
      const result = await data.bulkSaveCostProfile(ids, profile)
      await data.reload(range.value)
      if (result.failed > 0) {
        const succeeded = new Set(result.results.filter((row) => row.success).map((row) => row.account_id))
        selectedAccountIds.value = new Set(ids.filter((id) => !succeeded.has(Number(id))))
        appStore.showError(t('costCenter.text.savedAccountsFailed', { value0: result.success, value1: result.failed, value2: result.results.filter((row) => !row.success).map((row) => row.error || t('costCenter.text.account2', { value0: row.account_id })).join(t('costCenter.text.label2')) }))
        return
      }
      appStore.showSuccess(t('costCenter.text.savedCostSettingsForAccounts', { value0: result.success }))
      clearSelection()
      closeCostProfileInspector()
      return
    }
    const updated = await data.saveCostProfile(selectedAccount.value, profile)
    selectedAccount.value = updated
    appStore.showSuccess(t('costCenter.text.costSettingsSavedCumulativeCostRecalculated'))
  } catch (saveError: any) {
    appStore.showError(saveError?.message || t('costCenter.text.failedToSaveCostSettings'))
  }
}
async function toggleFullscreen() {
  try {
    if ('__TAURI_INTERNALS__' in (window as any)) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      const current = getCurrentWindow()
      await current.setFullscreen(!(await current.isFullscreen()))
    } else if (!document.fullscreenElement) {
      await document.documentElement.requestFullscreen()
    } else {
      await document.exitFullscreen()
    }
  } catch (fullscreenError) {
    fullscreenFailure.value = fullscreenError instanceof Error ? fullscreenError.message : String(fullscreenError)
  }
}

function handleKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') { event.preventDefault(); reload(); return }
  if (event.key === 'F11') { event.preventDefault(); toggleFullscreen(); return }
  if (event.key === 'Escape' && selectedAccount.value) { selectedAccount.value = null; return }
  const workspace = (event.ctrlKey || event.metaKey) && visibleWorkspaceItems.value.find(item => item.shortcut === event.key)
  if (workspace) { event.preventDefault(); activePanel.value = workspace.key }
}

async function refreshOnResume() {
  if (document.visibilityState !== 'visible') return
  countdown.value = refreshIntervalSeconds.value
  await reload(lastUpdated.value != null)
}

onMounted(async () => {
  void loadLocalCatalog()
  window.addEventListener('keydown', handleKeydown)
  document.addEventListener('visibilitychange', refreshOnResume)
  window.addEventListener('focus', refreshOnResume)
  clockTimer = window.setInterval(() => {
    now.value = new Date()
    if (!autoRefresh.value || document.visibilityState !== 'visible' || refreshing.value || loading.value) return
    countdown.value = Math.max(0, countdown.value - 1)
    if (countdown.value === 0) void reload(true)
  }, 1000)
  await reload()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown)
  document.removeEventListener('visibilitychange', refreshOnResume)
  window.removeEventListener('focus', refreshOnResume)
  if (clockTimer !== null) window.clearInterval(clockTimer)
})
</script>

<style scoped>
.cost-desktop-workspace { min-height: calc(100dvh - var(--desktop-titlebar-height, 0px)); display: flex; flex-direction: column; }
.cost-desktop-navigation { flex: none; }
.cost-desktop-workspace > .cost-console { flex: 1; min-height: 0; }

.cost-console {
  min-height: calc(100dvh - var(--desktop-titlebar-height, 0px));
  width: 100%;
  max-width: 100%;
  overflow-x: hidden;
  color: var(--cost-text);
  background-color: var(--cost-bg);
  background-image: linear-gradient(rgb(76 91 78 / 12%) 1px, transparent 1px), linear-gradient(90deg, rgb(76 91 78 / 12%) 1px, transparent 1px);
  background-size: 36px 36px;
  font-family: 'Segoe UI Variable', 'Microsoft YaHei UI', sans-serif;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

/* The economics console is an intentionally dark product surface regardless
   of the Windows/browser appearance. Keep the Apple semantic roles inside
   this boundary so content planes, functional materials, text, controls and
   popovers cannot fall back to the light profile. */
.cost-console[data-aui-fidelity="apple-fidelity-web/v1"][data-aui-appearance="dark"] {
  color-scheme: dark;
  --aui-accent: var(--cost-lime);
  --aui-accent-hover: #c3e975;
  --aui-accent-pressed: #caeb87;
  --aui-accent-wash: rgb(185 229 90 / 18%);
  --aui-accent-foreground: #10140f;
  --aui-label-primary: var(--cost-text);
  --aui-label-secondary: #a8b2aa;
  --aui-label-tertiary: var(--cost-muted);
  --aui-label-quaternary: #69756c;
  --aui-canvas: var(--cost-bg);
  --aui-content-plane: var(--cost-bg);
  --aui-content-plane-secondary: var(--cost-panel);
  --aui-fill: rgb(127 139 129 / 16%);
  --aui-fill-strong: rgb(127 139 129 / 28%);
  --aui-separator: rgb(66 77 67 / 78%);
  --aui-separator-opaque: var(--cost-line-strong);
  --aui-focus-outer: rgb(185 229 90 / 56%);
  --aui-material-regular-fill: rgb(13 17 14 / 96%);
  --aui-material-regular-border: rgb(66 77 67 / 82%);
  --aui-material-clear-fill: rgb(20 25 21 / 88%);
  --aui-material-clear-border: rgb(66 77 67 / 72%);
  color: var(--cost-text);
  background-color: var(--cost-bg);
}

.cost-console[data-aui-appearance="dark"] > main[data-aui-layer="content"] {
  color: var(--cost-text);
  background-color: var(--cost-bg);
  background-image:
    linear-gradient(rgb(76 91 78 / 12%) 1px, transparent 1px),
    linear-gradient(90deg, rgb(76 91 78 / 12%) 1px, transparent 1px);
  background-size: 36px 36px;
  border-color: var(--cost-line);
}
.cost-console--embedded { min-height: calc(100vh - 64px); margin: -1rem; }
.cost-console input, .cost-console select { user-select: text; -webkit-user-select: text; }
.cost-console :is(td, code, pre, .cost-error span), .cost-console :deep(.cost-metric-cell__value) { user-select: text; -webkit-user-select: text; }
button, select, input { font: inherit; }
button { border-radius: 0; }
button:focus-visible, select:focus-visible, input:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--cost-lime); outline-offset: -2px; }
button:active { transform: translateY(1px); }
.cost-eyebrow, .cost-section-heading > span, .cost-page-heading > div > span, .cost-quality-strip__intro > span { color: var(--cost-lime); font-family: 'Cascadia Mono', Consolas, monospace; font-size: 10px; letter-spacing: .055em; }
.cost-brand-block p, .cost-section-heading p, .cost-page-heading p, .cost-quality-strip__intro p { margin: 5px 0 0; color: var(--cost-muted); font-family: 'Cascadia Mono', Consolas, monospace; font-size: 10px; }
.cost-back-button { color: var(--cost-muted); }
.cost-back-button:hover { color: var(--cost-lime); }
.cost-select-label { display: flex; align-items: center; gap: 8px; color: var(--cost-muted); font-size: 11px; }
.cost-select-label select { height: 36px; padding: 0 30px 0 10px; color: var(--cost-text); background: #151a15; border: 1px solid var(--cost-line-strong); }
.cost-tool-button, .cost-icon-button, .cost-primary-button { display: inline-flex; height: 36px; align-items: center; justify-content: center; gap: 7px; padding: 0 12px; color: #a8b2aa; background: #151a15; border: 1px solid var(--cost-line-strong); font-size: 11px; }
.cost-icon-button { width: 36px; padding: 0; }
.cost-tool-button.active { color: var(--cost-lime); border-color: #6e8c37; }
.cost-governance-button.active { background: rgb(185 229 90 / 10%); }
.cost-primary-button { height: 40px; color: #11150f; background: var(--cost-lime); border-color: var(--cost-lime); font-size: 13px; font-weight: 720; }
.cost-primary-button--outline { color: var(--cost-lime); background: transparent; border-color: #75993a; }
.cost-error { display: flex; align-items: center; gap: 10px; padding: 10px 20px; color: #f0b6a6; background: #3a201b; border-bottom: 1px solid #78483b; font-size: 12px; }
.cost-error button { margin-left: auto; padding: 4px 8px; color: inherit; background: transparent; border: 1px solid currentColor; }
.cost-spin { animation: cost-spin .8s linear infinite; }
@keyframes cost-spin { to { transform: rotate(360deg); } }

.cost-workspace { padding: 24px; }
.cost-quality-strip { display: grid; min-height: 116px; grid-template-columns: minmax(380px, 1.7fr) repeat(4, minmax(160px, 1fr)); background: var(--cost-panel); border: 1px solid var(--cost-line-strong); }
.cost-quality-strip__intro { padding: 20px; border-right: 1px solid var(--cost-line); }
.cost-quality-strip__intro h2 { margin: 5px 0 0; font-size: 21px; }
.cost-metric-cell { position: relative; display: flex; min-width: 0; flex-direction: column; justify-content: center; padding: 13px 16px; border-right: 1px solid var(--cost-line); border-bottom: 1px solid var(--cost-line); }
.cost-metric-cell:last-child { border-right: 0; }
.cost-metric-cell::before { position: absolute; top: 0; bottom: 0; left: 0; width: 2px; content: ''; background: transparent; }
.cost-metric-cell.accent-lime::before { background: var(--cost-lime); }.cost-metric-cell.accent-gold::before { background: var(--cost-gold); }.cost-metric-cell.accent-blue::before { background: var(--cost-blue); }
/* 这里原先还有 4 条 `.cost-metric-cell > span / > strong / .accent-* > strong / > small`。
   它们**永不匹配**:Vue 的 scoped CSS 只把父组件的 scope id 打在子组件的**根元素**上,
   而 span/strong/small 在 TruthfulMetric 内部、只带子组件的 scope id ——
   编译出来是 `... > strong[data-v-父]`,命中不了。
   排版与 accent 配色已在 45f0faa 移入 TruthfulMetric.vue 的 scoped style(那里末位选择器
   带的是本组件 scope id,真正生效),所以这 4 条是纯冗余死规则,删除。
   注意:末位落在**根元素或其伪元素**上的规则(.cost-metric-cell / :last-child / ::before /
   .accent-*::before)是活规则,保留。 */

.cost-assets-row { display: grid; min-height: 240px; grid-template-columns: 1.1fr .7fr 2.5fr; margin-top: 18px; background: var(--cost-panel); border: 1px solid var(--cost-line); }
.cost-section-heading { align-self: center; padding: 22px; }.cost-section-heading h2 { margin: 8px 0 0; font-size: 22px; }
.cost-donut-wrap { display: grid; place-items: center; }
.cost-donut { display: grid; width: 140px; height: 140px; place-items: center; border-radius: 50%; }
.cost-donut > div { display: grid; width: 102px; height: 102px; place-items: center; align-content: center; border-radius: 50%; background: var(--cost-panel); }
.cost-donut strong { font: 700 17px 'Cascadia Mono', monospace; }.cost-donut span { margin-top: 5px; color: var(--cost-muted); font-size: 10px; }
.cost-metric-grid { display: grid; grid-template-columns: repeat(4, minmax(135px, 1fr)); border-left: 1px solid var(--cost-line); }
.cost-chart-row { display: grid; grid-template-columns: 1fr 1fr; margin-top: 18px; border: 1px solid var(--cost-line); }
/* 渠道配额条(P0-21):横向 chip 列表,只展示有账号的渠道。 */
.cost-quota-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 14px; padding: 12px 14px; background: var(--cost-panel); border: 1px solid var(--cost-line); }
.cost-quota-strip__intro { display: flex; flex-direction: column; gap: 3px; min-width: 180px; padding-right: 12px; border-right: 1px solid var(--cost-line); }
.cost-quota-strip__intro > span { color: var(--cost-muted); font: 9px 'Cascadia Mono', monospace; letter-spacing: .06em; text-transform: uppercase; }
.cost-quota-strip__intro > strong { font-size: 13px; }
.cost-quota-strip__intro > small { color: var(--cost-muted); font-size: 9px; line-height: 1.4; }
.cost-quota-strip__failed { color: #e39787; font-weight: 600; }
/* 审查 #10:整条配额横条在读取失败时"整体退色",与 ageDays≥1 的转灰同一套视觉语言 */
.cost-quota-strip.is-stale-error { border-color: rgb(227 151 135 / 38%); }
.cost-quota-strip__notice { display: flex; align-items: flex-start; gap: 5px; margin: 4px 0 0; color: #e39787; font-size: 10px; line-height: 1.45; }
.cost-quota-strip__notice svg { flex: none; margin-top: 1px; }
.cost-quota-strip__notice small { display: block; color: var(--cost-muted); font-size: 9px; word-break: break-all; }
.cost-quota-chip { display: flex; flex-direction: column; gap: 3px; min-width: 132px; padding: 7px 10px; border: 1px solid var(--cost-line); }
.cost-quota-chip > strong { font-size: 11px; }
.cost-quota-chip > span { font: 12px 'Cascadia Mono', monospace; }
.cost-quota-chip > small { color: var(--cost-muted); font: 9px 'Cascadia Mono', monospace; }

/* 未读维度诊断 chip 条（缺口 ③）：推理 token / 推理档位 / 网关通道。
   缺列时用 is-muted 明确标"该版本不提供"，而不是显示 0。 */
.cost-facet-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.cost-facet-chip { display: flex; flex-direction: column; gap: 3px; min-width: 190px; padding: 7px 10px; border: 1px solid var(--cost-line); }
.cost-facet-chip > span { color: var(--cost-muted); font: 9px 'Cascadia Mono', monospace; letter-spacing: .06em; text-transform: uppercase; }
.cost-facet-chip > strong { font-size: 11px; }
.cost-facet-chip > small { color: var(--cost-muted); font-size: 9px; line-height: 1.4; }
.cost-facet-chip.is-muted { opacity: .6; border-style: dashed; }
.cost-facet-chip.is-muted > strong { color: var(--cost-muted); }
.cost-cliproxy-reasoning { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 24px; width: 100%; margin: 16px 0; padding: 12px 0; border-block: 1px solid var(--cost-line); }
.cost-cliproxy-reasoning > .cost-facet-chip { min-width: 0; padding: 0; border: 0; }
.cost-cliproxy-reasoning > .cost-facet-chip:only-child { grid-column: 1 / -1; }
.cost-cliproxy-reasoning > .cost-facet-chip > :is(span, strong, small) { overflow-wrap: anywhere; }
.cost-chart-panel { min-width: 0; padding: 14px 18px 12px; background: var(--cost-panel); border-right: 1px solid var(--cost-line); }.cost-chart-panel:last-child { border-right: 0; }
.cost-panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }.cost-panel-heading strong { font-size: 12px; }.cost-panel-heading span { color: var(--cost-muted); font: 9px 'Cascadia Mono', monospace; }
.cost-bottom-row { display: grid; grid-template-columns: 2.2fr 1fr; margin-top: 18px; border: 1px solid var(--cost-line); }.cost-score-panel { border-right: 1px solid var(--cost-line); }
.cost-distribution-panel { min-width: 0; padding: 14px 18px; background: var(--cost-panel); }
.cost-distribution-panel__body { display: grid; grid-template-columns: 145px 1fr; align-items: center; gap: 14px; margin-top: 12px; }
.cost-donut--small { width: 130px; height: 130px; }.cost-donut--small > div { width: 92px; height: 92px; }
.cost-ranking-list { margin: 0; padding: 0; list-style: none; }.cost-ranking-list li { display: grid; grid-template-columns: 7px 1fr auto; align-items: center; gap: 9px; padding: 7px 0; border-bottom: 1px solid #273027; }.cost-ranking-list li:last-child { border-bottom: 0; }
.cost-swatch { width: 7px; height: 7px; }.cost-ranking-list strong, .cost-ranking-list small { display: block; max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.cost-ranking-list strong { font-size: 10px; }.cost-ranking-list small { margin-top: 3px; color: var(--cost-muted); font: 8px 'Cascadia Mono', monospace; }.cost-ranking-list b { font: 10px 'Cascadia Mono', monospace; }

.cost-page-heading { display: flex; min-height: 108px; align-items: center; justify-content: space-between; gap: 20px; padding: 12px 6px 22px; }.cost-page-heading h2 { margin: 6px 0 0; font-size: 29px; }.cost-page-heading--compact { min-height: auto; padding: 0; }
.cost-page-heading__actions { display: flex; flex: 0 0 auto; align-items: center; gap: 9px; }
.cost-table-tools { display: flex; align-items: center; gap: 16px; min-height: 54px; padding: 0 0 12px; }
.cost-platform-tabs { display: flex; align-items: stretch; border: 1px solid var(--cost-line-strong); }.cost-platform-tabs button { min-width: 110px; height: 38px; padding: 0 18px; color: #89948b; background: #151a15; border: 0; border-right: 1px solid var(--cost-line); }.cost-platform-tabs button:last-child { border-right: 0; }.cost-platform-tabs button.active { color: #10140f; background: var(--cost-lime); font-weight: 700; }
.cost-refresh-stamp { color: #808b82; font: 11px 'Cascadia Mono', monospace; }.cost-search { display: flex; width: 280px; height: 36px; align-items: center; gap: 8px; margin-left: auto; padding: 0 10px; color: var(--cost-muted); background: #151a15; border: 1px solid var(--cost-line-strong); }.cost-search input { width: 100%; color: var(--cost-text); background: transparent; border: 0; outline: 0; font-size: 11px; }
.cost-data-table-wrap { max-height: calc(100vh - 260px); overflow: auto; border: 1px solid var(--cost-line); background: rgb(13 17 14 / 72%); }
.cost-data-table { width: 100%; min-width: 1740px; border-collapse: separate; border-spacing: 0; table-layout: fixed; font-size: 11px; }.cost-data-table th { position: sticky; z-index: 3; top: 0; height: 45px; padding: 0 10px; color: #77847a; background: #202720; border-right: 1px solid #2d352e; text-align: left; font-weight: 500; }.cost-data-table td { height: 72px; padding: 8px 10px; vertical-align: middle; border-right: 1px solid #222a23; border-bottom: 1px solid #293129; }.cost-data-table tbody tr { background: rgb(13 17 14 / 76%); }.cost-data-table tbody tr:nth-child(3n) { background: rgb(19 25 18 / 82%); }.cost-data-table tbody tr.status-error { background: rgb(74 39 30 / 54%); box-shadow: inset 3px 0 #d36f4c; }.cost-data-table tbody tr.status-limited { background: rgb(74 62 30 / 42%); box-shadow: inset 3px 0 #d6aa47; }.cost-data-table tbody tr.selected { box-shadow: inset 3px 0 var(--cost-lime); }
.cost-data-table td strong, .cost-data-table td small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.cost-data-table td strong { color: #e4e9e1; font: 600 11px 'Cascadia Mono', Consolas, monospace; }.cost-data-table td small { margin-top: 5px; color: #69756b; font: 9px 'Cascadia Mono', monospace; }.cost-account-cell strong { font-size: 12px !important; }.cost-lime { color: var(--cost-lime) !important; }
.cost-data-table td strong { overflow: visible; white-space: normal; overflow-wrap: anywhere; }
.cost-score { display: inline-block; padding: 6px 8px; color: var(--cost-lime); background: rgb(185 229 90 / 10%); font: 700 12px 'Cascadia Mono', monospace; }.cost-score[data-grade='C'], .cost-score[data-grade='D'] { color: #dc8664; background: rgb(184 87 55 / 12%); }
.cost-status-label { display: grid; grid-template-columns: 7px 1fr; align-items: center; gap: 7px; }.cost-status-label i { width: 7px; height: 7px; border-radius: 50%; background: var(--cost-lime); }.cost-status-label strong { color: var(--cost-lime) !important; }.cost-status-label small { grid-column: 2; margin-top: 0 !important; }.cost-status-label.status-error i { background: #e07758; }.cost-status-label.status-error strong { color: #e07758 !important; }.cost-status-label.status-limited i { background: #d6aa47; }.cost-status-label.status-limited strong { color: #d6aa47 !important; }.cost-status-label.status-inactive i { background: #77847a; }.cost-status-label.status-inactive strong { color: #9aa59b !important; }
.cost-group-cell { white-space: normal; }.cost-tag { display: inline-block; margin: 2px 3px 2px 0; padding: 3px 6px; color: #a3ada5; border: 1px solid #39423a; font: 9px 'Cascadia Mono', monospace; }.cost-actions-cell { white-space: nowrap; }.cost-actions-cell button { display: inline-grid; width: 29px; height: 29px; margin-right: 4px; place-items: center; color: var(--cost-lime); background: #151a15; border: 1px solid #3e483f; }.cost-empty-row { height: 180px !important; color: var(--cost-muted); text-align: center; }.cost-muted { color: var(--cost-muted); font: 10px 'Cascadia Mono', monospace; }
/* 「无从判断」的统一中性色(derived/不可得),不复用实测值的 lime 强调色。
   !important 是必需的:.cost-data-table td strong 与 .cost-model-table td strong 特异性更高(0-1-2),
   否则本类(0-1-0)会被盖掉,「—/无数据」退化成与正常值同色的白字,中性色契约形同虚设。 */
.cost-unknown-value { color: #9aa79b !important; }

.cost-oauth-heading { display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 6px 16px; margin-bottom: 10px; }
.cost-oauth-heading h2 { margin: 0; font-size: 20px; line-height: 1.4; }
.cost-oauth-heading p { margin: 0; color: var(--cost-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.cost-pool-heading-row { display: grid; grid-template-columns: minmax(210px, 1fr) auto auto; align-items: center; gap: 12px; margin: 14px 0 12px; }
.cost-pool-heading-row .cost-section-heading { min-width: 0; padding: 0; }
.cost-oauth .cost-pool-heading-row h2 { margin: 0; font-size: 17px; line-height: 1.4; }
.cost-pool-heading-row > .cost-platform-tabs { min-width: 0; max-width: min(58vw, 920px); overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: thin; }
.cost-pool-heading-row > .cost-platform-tabs button { flex: 0 0 auto; }
.cost-pool-summary { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border-block: 1px solid var(--cost-line); background: var(--cost-panel); }
.cost-pool-summary > .cost-metric-cell { display: grid; grid-row: span 3; grid-template-rows: subgrid; row-gap: 7px; justify-content: stretch; align-content: start; padding: 14px 16px; }
.cost-pool-summary > .cost-metric-cell:nth-child(6n) { border-right: 0; }
.cost-oauth .cost-pool-summary :deep(.cost-metric-cell__heading) { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
.cost-oauth .cost-pool-summary :deep(.cost-metric-cell__label) { font-size: 11px; line-height: 1.5; }
.cost-oauth .cost-pool-summary :deep(.cost-metric-cell__value) { margin: 0; font-size: 18px; line-height: 1.4; }
.cost-oauth .cost-pool-summary :deep(.cost-metric-cell__note) { margin: 0; font-size: 10px; line-height: 1.5; }
.cost-pool-output { display: flex; grid-column: 1 / -1; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 11px 16px; }
.cost-pool-output > span { color: var(--cost-muted); font-size: 11px; }
.cost-pool-output > strong { color: var(--cost-muted); font: 600 14px 'Cascadia Mono', monospace; }
.cost-pool-output > div { flex: 1 1 80px; max-width: 160px; height: 4px; background: var(--cost-line); overflow: hidden; }
.cost-pool-output i { display: block; height: 100%; background: var(--cost-lime); }
.cost-pool-output small { margin-left: auto; color: var(--cost-muted); font: 10px 'Cascadia Mono', monospace; }
@media (max-width: 1280px) {
  .cost-pool-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .cost-pool-summary > .cost-metric-cell:nth-child(3n) { border-right: 0; }
}
.cost-pool-table-wrap { margin-top: 18px; overflow: auto; border: 1px solid var(--cost-line); }.cost-pool-table { width: 100%; min-width: 1450px; border-collapse: collapse; background: rgb(13 17 14 / 76%); font-size: 11px; }.cost-pool-table th { height: 44px; padding: 0 14px; color: #78847a; background: #202720; border-right: 1px solid #313a32; text-align: left; font-weight: 500; }.cost-pool-table td { min-height: 88px; padding: 14px; border-right: 1px solid #273027; border-bottom: 1px solid #303830; }.cost-pool-table td strong, .cost-pool-table td small { display: block; }.cost-pool-table td strong { font: 600 12px 'Cascadia Mono', monospace; }.cost-pool-table td small { margin-top: 7px; color: #707c72; font: 9px 'Cascadia Mono', monospace; }.cost-status-ring { display: inline-grid; width: 38px; height: 38px; place-items: center; border-radius: 50%; }.cost-status-ring span { width: 22px; height: 22px; border-radius: 50%; background: var(--cost-bg); }.cost-pool-progress { width: 100%; margin-top: 8px; }

@media (max-width: 1450px) {.cost-quality-strip { grid-template-columns: minmax(320px, 1.4fr) repeat(4, 1fr); }.cost-assets-row { grid-template-columns: 1fr .75fr 2.2fr; }.cost-metric-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 1180px) {.cost-quality-strip { grid-template-columns: repeat(2, 1fr); }.cost-quality-strip__intro { grid-column: 1 / -1; }.cost-assets-row { grid-template-columns: 1fr 1fr; }.cost-metric-grid { grid-column: 1 / -1; border-top: 1px solid var(--cost-line); border-left: 0; }.cost-bottom-row, .cost-chart-row { grid-template-columns: 1fr; }.cost-chart-panel { border-right: 0; border-bottom: 1px solid var(--cost-line); } }
@media (max-width: 760px) { .cost-workspace { padding: 12px; }.cost-quality-strip, .cost-assets-row, .cost-metric-grid, .cost-bottom-row, .cost-pool-summary { grid-template-columns: 1fr; }.cost-pool-summary > .cost-metric-cell:nth-child(n) { border-right: 0; }.cost-quality-strip__intro, .cost-metric-grid { grid-column: auto; }.cost-donut-wrap { padding: 20px; }.cost-table-tools { flex-wrap: wrap; }.cost-search { width: 100%; margin-left: 0; }.cost-refresh-stamp { order: 3; width: 100%; }.cost-pool-heading-row { grid-template-columns: 1fr; }.cost-pool-heading-row > .cost-platform-tabs { width: 100%; max-width: 100%; }.cost-page-heading { align-items: flex-start; flex-direction: column; }.cost-page-heading__actions { width: 100%; flex-wrap: wrap; }.cost-distribution-panel__body { grid-template-columns: 1fr; }.cost-donut--small { margin: 0 auto; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; } }

/* Apple-inspired spatial tuning: preserve the dark/lime palette while making
   the console calmer, denser and easier to scan at desktop sizes. */
.cost-console {
  --cost-radius-sm: 9px;
  --cost-radius-md: 13px;
  --cost-radius-lg: 16px;
}

.cost-console main {
  width: min(100%, 2048px);
  margin: 0 auto;
}

.cost-console button,
.cost-console select,
.cost-console input,
.cost-console .cost-data-table-wrap,
.cost-console .cost-pool-table-wrap,
.cost-console .cost-quality-strip,
.cost-console .cost-assets-row,
.cost-console .cost-chart-row,
.cost-console .cost-bottom-row {
  border-radius: var(--cost-radius-md);
}

.cost-console button {
  transition: transform 160ms ease, background-color 160ms ease, border-color 160ms ease, color 160ms ease, box-shadow 160ms ease;
}

.cost-console button:hover:not(:disabled) {
  border-color: #60715f;
  box-shadow: 0 5px 16px rgb(0 0 0 / 18%);
}

.cost-console button:active:not(:disabled) {
  transform: translateY(1px) scale(.985);
  box-shadow: none;
}

.cost-select-label select,
.cost-tool-button,
.cost-icon-button,
.cost-primary-button {
  height: 38px;
  border-radius: var(--cost-radius-sm);
}

.cost-select-label select { padding-right: 28px; }
.cost-icon-button { width: 38px; }
.cost-primary-button { padding-inline: 15px; }

.cost-workspace {
  padding: 20px 24px 32px;
}

.cost-quality-strip {
  min-height: 102px;
  overflow: hidden;
  box-shadow: 0 8px 22px rgb(0 0 0 / 12%);
}

.cost-quality-strip__intro {
  padding: 16px 18px;
}

.cost-quality-strip__intro h2 {
  font-size: 20px;
  letter-spacing: 0;
}

.cost-metric-cell {
  padding: 12px 14px;
}

.cost-metric-cell :deep(.cost-metric-cell__value) {
  margin-top: 5px;
  font-size: 18px;
}

.cost-assets-row {
  min-height: 216px;
  margin-top: 16px;
  overflow: hidden;
  box-shadow: 0 8px 22px rgb(0 0 0 / 10%);
}

.cost-section-heading {
  padding: 18px;
}

.cost-section-heading h2 {
  margin-top: 6px;
  font-size: 22px;
  letter-spacing: 0;
}

.cost-donut {
  width: 126px;
  height: 126px;
}

.cost-donut > div {
  width: 92px;
  height: 92px;
}

.cost-metric-grid { overflow: hidden; }

.cost-chart-row,
.cost-bottom-row {
  margin-top: 16px;
  overflow: hidden;
  box-shadow: 0 8px 22px rgb(0 0 0 / 9%);
}

.cost-chart-panel,
.cost-distribution-panel {
  padding: 15px 16px 13px;
}

.cost-panel-heading strong { font-size: 12px; letter-spacing: 0; }

.cost-page-heading {
  min-height: 94px;
  padding: 8px 4px 18px;
}

.cost-page-heading h2 {
  font-size: 24px;
  letter-spacing: 0;
}

.cost-platform-tabs {
  gap: 3px;
  padding: 3px;
  border-radius: var(--cost-radius-md);
  background: rgb(18 23 19 / 84%);
}

.cost-platform-tabs button {
  display: inline-flex;
  min-width: 94px;
  height: 36px;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding-inline: 14px;
  border: 0;
  border-radius: 7px;
  white-space: nowrap;
}

.cost-platform-tabs button:last-child { border-right: 0; }

.cost-platform-tabs button small {
  display: inline-grid;
  min-width: 18px;
  height: 18px;
  place-items: center;
  padding: 0 5px;
  color: #96a198;
  background: #222b23;
  border-radius: 9px;
  font: 9px 'Cascadia Mono', monospace;
}

.cost-platform-tabs button.active small {
  color: #182014;
  background: rgb(16 20 15 / 16%);
}

.cost-table-tools {
  flex-wrap: wrap;
}

.cost-table-tools > .cost-platform-tabs {
  min-width: 0;
  max-width: 100%;
  flex: 1 1 560px;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
}

.cost-table-tools > .cost-platform-tabs button {
  flex: 0 0 auto;
}

.cost-search,
.cost-error button,
.cost-tag,
.cost-score,
.cost-actions-cell button {
  border-radius: var(--cost-radius-sm);
}

.cost-data-table-wrap,
.cost-pool-table-wrap {
  overflow: auto;
  box-shadow: 0 8px 22px rgb(0 0 0 / 9%);
}

.cost-data-table th,
.cost-pool-table th {
  height: 42px;
}

.cost-data-table td { height: 66px; }
.cost-data-table tbody tr { transition: background-color 160ms ease; }
.cost-data-table tbody tr:hover { background: rgb(35 46 34 / 84%); }

.cost-tag {
  padding: 4px 7px;
}

.cost-ranking-bar {
  display: flex;
  min-height: 52px;
  align-items: center;
  gap: 18px;
  margin: -2px 0 10px;
  padding: 8px 12px;
  border: 1px solid #354136;
  border-radius: 12px;
  background: rgb(20 27 21 / 82%);
}

.cost-ranking-bar__title {
  display: flex;
  min-width: 165px;
  align-items: center;
  gap: 9px;
  color: var(--cost-lime);
}

.cost-ranking-bar__title strong,
.cost-ranking-bar__title span {
  display: block;
}

.cost-ranking-bar__title strong { color: #e3ebdf; font-size: 12px; }
.cost-ranking-bar__title span { margin-top: 3px; color: #77847a; font: 9px 'Cascadia Mono', monospace; }

.cost-ranking-select {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8a978d;
  font-size: 10px;
}

.cost-ranking-select select {
  height: 32px;
  min-width: 132px;
  padding: 0 28px 0 9px;
  color: #dce7dc;
  background: #161d17;
  border: 1px solid #465348;
  border-radius: 8px;
  font-size: 11px;
}

.cost-ranking-bar__summary {
  margin-left: auto;
  color: #8c988e;
  font: 10px 'Cascadia Mono', monospace;
  white-space: nowrap;
}

.cost-account-primary {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 7px;
}

.cost-account-primary strong {
  min-width: 0;
  flex: 1;
}

.cost-rank-badge {
  display: inline-grid;
  flex: 0 0 27px;
  height: 22px;
  place-items: center;
  color: #9aaa9d;
  background: #1b241c;
  border: 1px solid #3e4b40;
  border-radius: 6px;
  font: 700 9px 'Cascadia Mono', monospace;
}

.cost-rank-badge[data-rank='1'] { color: #10150e; background: var(--cost-lime); border-color: var(--cost-lime); }
.cost-rank-badge[data-rank='2'] { color: #132019; background: #8bb9d0; border-color: #8bb9d0; }
.cost-rank-badge[data-rank='3'] { color: #1c170c; background: #d3ad4e; border-color: #d3ad4e; }
.cost-rank-badge.is-unranked { flex-basis: 42px; color: #748078; background: transparent; border-style: dashed; font-weight: 500; }
.cost-score.is-unavailable { color: #79847c; background: #192019; font-weight: 500; }
/* 推算分(由账号状态派生,非内核调度分):中性灰 + 无 grade 底色,绝不与实测分同款强调色。 */
.cost-score.is-derived { color: #9aa79b; background: #1c221d; box-shadow: inset 0 0 0 1px #3d4a3e; font-weight: 500; }
/* 采购列推算值:不用实测强调色 lime,改中性灰。 */
.cost-estimated { color: #9aa79b !important; }
/* 「推算」标记:虚线框 + 小号字,数字旁显式声明这不是实测值。 */
.cost-derived-tag { display: inline-block; margin-left: 5px; padding: 0 3px; border: 1px dashed #5d6b5e; border-radius: 3px; color: #8b988c; font: 600 8px/1.5 'Cascadia Mono', Consolas, monospace; font-style: normal; letter-spacing: .04em; vertical-align: 1px; }

@media (max-width: 900px) {
  .cost-ranking-bar {
    align-items: stretch;
    flex-direction: column;
    gap: 9px;
  }

  .cost-ranking-bar__title { min-width: 0; }
  .cost-ranking-select { justify-content: space-between; }
  .cost-ranking-select select { flex: 1; }
  .cost-ranking-bar__summary { margin-left: 0; white-space: normal; }
}

.cost-actions-cell button {
  width: 32px;
  height: 32px;
}

.cost-pool-table-wrap { margin-top: 16px; }

@media (max-width: 760px) {
  .cost-workspace { padding: 14px 12px 24px; }
}

@media (prefers-reduced-motion: reduce) {
  .cost-console button,
  .cost-console tbody tr {
    transition: none !important;
  }
}

/* Keep wide operational tables usable on narrow windows without changing the palette. */
.cost-upstreams {
  min-width: 0;
}

.cost-table-scroll-hint {
  display: none;
  align-items: center;
  gap: 6px;
  margin: -4px 0 8px;
  color: #9aa69c;
  font-size: 11px;
}

.cost-data-table-wrap {
  width: 100%;
  max-width: 100%;
  overflow-x: scroll;
  overflow-y: auto;
  scrollbar-gutter: stable;
  overscroll-behavior: contain;
}

.cost-data-table th:first-child,
.cost-data-table td:first-child {
  position: sticky;
  z-index: 4;
  left: 0;
  background: #111711;
  box-shadow: 8px 0 14px rgb(0 0 0 / 16%);
}

.cost-data-table th:first-child {
  background: #202720;
}

.cost-data-table th:last-child,
.cost-data-table td:last-child {
  position: sticky;
  z-index: 4;
  right: 0;
  background: #111711;
  box-shadow: -8px 0 14px rgb(0 0 0 / 16%);
}

.cost-data-table th:last-child {
  background: #202720;
}

/* 表头角落单元格(同时 sticky top+left/right)层级高于正文 sticky 列,斜向滚动时不被盖住 */
.cost-data-table thead th:first-child,
.cost-data-table thead th:last-child {
  z-index: 5;
}

@media (max-width: 1800px) {
  .cost-table-scroll-hint {
    display: flex;
  }
}

.cost-provenance-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  margin-top: 12px;
  overflow: hidden;
  border: 1px solid var(--cost-line);
  border-radius: var(--cost-radius-md);
  background: var(--cost-line);
}

.cost-provenance-strip.has-default-warning {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

/* 3 项基础 + 默认价告警 + 倍率兜底告警 → 5 列;窄屏由下方 media query 自动折行 */
.cost-provenance-strip.has-default-warning.has-fallback-note {
  grid-template-columns: repeat(5, minmax(0, 1fr));
}

.cost-provenance-strip > div {
display: grid;
min-width: 0;
grid-template-columns: 20px 1fr;
align-items: center;
padding: 10px 12px;
background: rgb(20 25 21 / 96%);
}

.cost-provenance-strip svg { grid-row: 1 / span 2; color: var(--cost-lime); }
.cost-provenance-strip strong { font-size: 10px; }
.cost-provenance-strip span { margin-top: 3px; color: var(--cost-muted); font-size: 9px; }
.cost-provenance-strip .is-warning svg,
.cost-provenance-strip .is-warning strong { color: #e0bd4e; }

.cost-scope-notice {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 5px 12px;
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid #3d4c3d;
  border-left: 3px solid var(--cost-lime);
  border-radius: var(--cost-radius-md);
  background: rgb(24 33 24 / 88%);
}

.cost-scope-notice strong { color: var(--cost-lime); font-size: 11px; }
.cost-scope-notice span { color: #c4ccc3; font-size: 11px; }
.cost-scope-notice small { grid-column: 2; color: var(--cost-muted); font: 9px 'Cascadia Mono', monospace; }
.cost-oauth .cost-scope-notice { margin: 0; padding: 0 0 10px; border: 0; border-bottom: 1px solid var(--cost-line); border-radius: 0; background: transparent; gap: 4px 10px; }
.cost-oauth .cost-scope-notice strong { color: var(--cost-muted); font-weight: 500; }

.cost-actions-cell button {
  position: relative;
  cursor: pointer;
}

.cost-actions-cell button:disabled { cursor: wait; opacity: .72; }
.cost-actions-cell button.is-success { color: #b9e55a; border-color: #6e873b; background: rgb(185 229 90 / 10%); }
.cost-actions-cell button.is-error { color: #e48a72; border-color: #885243; background: rgb(228 138 114 / 10%); }

.cost-action-tooltip {
  position: absolute;
  z-index: 30;
  top: 50%;
  right: calc(100% + 9px);
  width: max-content;
  max-width: 260px;
  padding: 7px 9px;
  color: #eef3ea;
  background: rgb(27 34 28 / 98%);
  border: 1px solid #536053;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 32%);
  opacity: 0;
  pointer-events: none;
  transform: translate(4px, -50%);
  transition: opacity 120ms ease, transform 120ms ease;
  font: 10px/1.45 system-ui, sans-serif;
  white-space: normal;
}

.cost-usage-windows {
  display: grid;
  min-width: 145px;
  gap: 5px;
}

.cost-usage-windows > span {
  display: grid;
  grid-template-columns: max-content minmax(20px, 1fr) 33px;
  align-items: center;
  gap: 5px;
}

.cost-usage-windows b,
.cost-usage-windows strong {
  color: #bdc8bd;
  font: 600 10px 'Cascadia Mono', Consolas, monospace;
}

.cost-usage-windows strong { text-align: right; }
.cost-usage-windows i { display: block; height: 6px; overflow: hidden; background: #3a423b; border-radius: 999px; }
.cost-usage-windows em { display: block; height: 100%; background: var(--cost-lime); border-radius: inherit; }
/* 配额窗口四级配色(对齐 cockpit 原版 CodexQuotaMiniRows):消耗分级 high→critical */
.cost-usage-windows em[data-grade='high'] { background: #4ade80; }
.cost-usage-windows em[data-grade='medium'] { background: #f0b429; }
.cost-usage-windows em[data-grade='low'] { background: #f08b3a; }
.cost-usage-windows em[data-grade='critical'] { background: #e0654a; }
.cost-usage-windows strong[data-grade='high'] { color: #4ade80; }
.cost-usage-windows strong[data-grade='medium'] { color: #f0b429; }
.cost-usage-windows strong[data-grade='low'] { color: #f08b3a; }
.cost-usage-windows strong[data-grade='critical'] { color: #e0654a; }
/* 未知利用率:灰色 + 虚线,绝不给绿色(绿色是"健康"的正向断言,而我们其实不知道) */
.cost-usage-windows em[data-grade='unknown'] { background: repeating-linear-gradient(90deg, #5a615a 0 4px, transparent 4px 8px); }
.cost-usage-windows strong[data-grade='unknown'] { color: #8b938b; }
.cost-usage-windows small { grid-column: 2 / -1; margin-top: -2px !important; color: #78857a; font: 8px 'Cascadia Mono', Consolas, monospace; }
.cost-data-table .cost-usage-windows small { overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }
.cost-usage-windows .cost-quota-stamp { grid-column: 1 / -1; }
.cost-usage-windows .cost-quota-error { color: var(--cost-gold); }

.cost-actions-cell button:hover .cost-action-tooltip,
.cost-actions-cell button:focus-visible .cost-action-tooltip {
  opacity: 1;
  transform: translate(0, -50%);
}

@media (max-width: 1180px) {
  .cost-provenance-strip,
  .cost-provenance-strip.has-default-warning { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 760px) {
  .cost-provenance-strip,
  .cost-provenance-strip.has-default-warning { grid-template-columns: 1fr; }
  .cost-scope-notice { grid-template-columns: 1fr; }
  .cost-scope-notice small { grid-column: 1; }
}

.cost-selection-bar { display: flex; min-height: 48px; align-items: center; gap: 14px; margin: 10px 0; padding: 0 14px; color: #aeb9ae; background: #141b15; border: 1px solid var(--cost-line); border-radius: var(--cost-radius-md); }
.cost-check-label { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; }
.cost-check-label input, .cost-select-column input { width: 15px; height: 15px; accent-color: var(--cost-lime); }
.cost-selection-count { color: var(--cost-muted); font: 10px 'Cascadia Mono', monospace; }
.cost-selection-bar .cost-primary-button { margin-left: auto; }
.cost-selection-bar .cost-text-button { padding: 4px 6px; color: var(--cost-muted); background: transparent; border: 0; font-size: 11px; }
.cost-select-column { text-align: center !important; }
.cost-data-table tbody tr.row-selected { background: rgb(42 65 31 / 48%); }
.cost-refresh-interval-label span { white-space: nowrap; }
.cost-model-panel {
  min-width: 0;
  margin-top: 16px;
  overflow: hidden;
  background: rgb(13 17 14 / 78%);
  border: 1px solid var(--cost-line);
  border-radius: var(--cost-radius-md);
  box-shadow: 0 8px 22px rgb(0 0 0 / 9%);
}
.cost-model-panel__header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  padding: 17px 18px 14px;
  border-bottom: 1px solid var(--cost-line);
}
.cost-model-panel__header > div:first-child { min-width: 0; }
.cost-model-panel__header span { color: #7f8b81; font: 9px 'Cascadia Mono', monospace; letter-spacing: .08em; }
.cost-model-panel__header h2 { margin: 5px 0 0; color: #e3ebdf; font-size: 17px; }
.cost-model-panel__header p { margin: 5px 0 0; color: #77847a; font-size: 10px; }
.cost-model-controls { display: flex; flex: 0 1 820px; justify-content: flex-end; gap: 10px; }
.cost-model-controls label { display: grid; min-width: 150px; gap: 5px; }
.cost-model-controls .cost-model-controls__account { flex: 1; min-width: 250px; }
.cost-model-controls select {
  width: 100%;
  height: 34px;
  padding: 0 28px 0 9px;
  color: #dce7dc;
  background: #161d17;
  border: 1px solid #3b463c;
  border-radius: 7px;
  font-size: 11px;
}
.cost-model-summary { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); }
.cost-model-summary .cost-metric-cell { min-width: 0; border-bottom: 1px solid var(--cost-line); }
.cost-model-audit-summary { background: rgb(25 34 27 / 74%); border-top: 1px solid #354236; }
.cost-pricing-status {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 16px;
  color: #9eaa9f;
  background: rgb(31 43 31 / 76%);
  border-bottom: 1px solid var(--cost-line);
}
.cost-pricing-status > div { min-width: 0; }
.cost-pricing-status span,
.cost-pricing-status strong,
.cost-pricing-status small { display: block; }
.cost-pricing-status strong { margin-top: 3px; color: #dce8d9; font-size: 11px; }
.cost-pricing-status small { margin-top: 3px; color: #738077; font: 9px 'Cascadia Mono', monospace; overflow-wrap: anywhere; }
.cost-pricing-status button {
  display: inline-flex;
  height: 32px;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
  padding: 0 11px;
  color: var(--cost-lime);
  background: #141b15;
  border: 1px solid #54712e;
  border-radius: 8px;
  font-size: 10px;
}
.cost-pricing-status button:disabled { cursor: wait; opacity: .65; }
.cost-pricing-status.is-unavailable { border-left: 2px solid #b8785e; }
.cost-model-note { margin: 0; padding: 10px 16px; color: #89958b; background: rgb(38 47 39 / 42%); border-bottom: 1px solid var(--cost-line); font-size: 10px; line-height: 1.55; }
.cost-model-note--warning { color: #d7bb73; border-left: 2px solid #d7bb73; background: rgb(93 72 31 / 22%); }
.cost-model-contribution { padding: 14px 16px 8px; border-bottom: 1px solid var(--cost-line); background: #111611; }
.cost-route-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; background: #151c16; border-top: 1px solid #3a443b; border-bottom: 1px solid var(--cost-line); }
.cost-route-heading strong, .cost-route-heading span { display: block; }
.cost-route-heading strong { color: #dce5da; font-size: 12px; }
.cost-route-heading span, .cost-route-heading small { margin-top: 4px; color: #778379; font-size: 9px; }
.cost-audit-badge { width: fit-content; padding: 3px 6px; border: 1px solid #475348; border-radius: 999px; }
.cost-audit-badge.is-matched { color: var(--cost-lime); border-color: rgb(185 229 90 / 45%); background: rgb(185 229 90 / 8%); }
.cost-audit-badge.is-mismatch { color: #efbd69; border-color: rgb(239 189 105 / 55%); background: rgb(118 75 18 / 22%); }
.cost-audit-badge.is-unobserved { color: #7f8a81; }
.cost-model-table-wrap { max-width: 100%; overflow: auto; }
.cost-model-table { width: 100%; min-width: 1050px; border-collapse: collapse; font-size: 11px; }
.cost-route-table { min-width: 1500px; }
.cost-model-table th { height: 40px; padding: 0 12px; color: #78847a; background: #202720; border-right: 1px solid #313a32; text-align: left; font-weight: 500; white-space: nowrap; }
.cost-model-table td { padding: 12px; color: #c8d1c8; border-right: 1px solid #273027; border-bottom: 1px solid #303830; font-family: 'Cascadia Mono', Consolas, monospace; }
.cost-model-table td strong, .cost-model-table td small { display: block; }
.cost-model-table td strong { color: #e1e8df; font-size: 11px; }
.cost-model-table td small { margin-top: 5px; color: #707c72; font-size: 9px; }
.cost-model-table .cost-warning-text { color: #e69a7d; }

@media (max-width: 1180px) {
  .cost-model-panel__header { align-items: stretch; flex-direction: column; }
  .cost-model-controls { flex: none; justify-content: flex-start; }
  .cost-model-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 760px) {
  .cost-model-controls { flex-direction: column; }
  .cost-model-controls label,
  .cost-model-controls .cost-model-controls__account { min-width: 0; }
  .cost-pricing-status { align-items: stretch; flex-direction: column; }
  .cost-pricing-status button { align-self: flex-start; }
  .cost-model-summary { grid-template-columns: 1fr; }
}


/* ==================== 三端汇总 workspace ==================== */
.cost-unified { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: 18px; }
.cost-unified-sources { display: flex; flex-wrap: wrap; gap: 12px; padding: 14px 16px; background: var(--cost-panel); border: 1px solid var(--cost-line); }
.cost-source-toggle { display: flex; align-items: center; gap: 9px; padding: 9px 14px; cursor: pointer; border: 1px solid var(--cost-line-strong); background: #151a15; transition: border-color .15s; }
.cost-source-toggle.active { border-color: var(--cost-lime); }
.cost-source-toggle input { accent-color: var(--cost-lime); }
.cost-source-dot { width: 9px; height: 9px; border-radius: 50%; }
.cost-source-dot.source-sub2api { background: var(--cost-gold); }
.cost-source-dot.source-cliproxy { background: #79b6d9; }
.cost-source-dot.source-cockpit { background: var(--cost-lime); }
.cost-source-name { color: var(--cost-text); font: 600 12px 'Cascadia Mono', monospace; text-transform: uppercase; }
.cost-source-state { margin-left: auto; padding-left: 12px; color: var(--cost-muted); font: 9px 'Cascadia Mono', monospace; }
.cost-source-state.state-measured { color: var(--cost-lime); }
.cost-source-state.state-estimated { color: var(--cost-gold); }
/* 下界(有值,但少算了一部分)—— 与 estimated 同色系,语义靠文案区分 */
.cost-source-state.state-partial { color: var(--cost-gold); }
.cost-source-state.state-unavailable { color: #d36f4c; }
.cost-unified-total { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 22px; align-items: stretch; }
.cost-donut--unified { width: 100%; height: auto; min-height: 170px; background: none; }
.cost-donut--unified > div { width: 100%; height: auto; padding: 12px; border-radius: 0; background: transparent; }
.cost-donut--unified small { margin-top: 8px; line-height: 1.6; overflow-wrap: anywhere; }
.cost-donut--unified strong { font-size: 22px; color: var(--cost-muted); }
.cost-metric-grid--tokens { grid-template-columns: repeat(4, 1fr); }
.cost-table-wrap { min-width: 0; max-width: 100%; overflow-x: auto; border: 1px solid var(--cost-line); background: var(--cost-panel); }
.cost-historical-details { min-width: 0; }
.cost-historical-details > summary { padding: 14px 0; color: var(--cost-muted); cursor: pointer; }
.cost-table-wrap .cost-section-heading { padding: 14px 16px; }
.cost-window-table { width: 100%; min-width: 760px; table-layout: fixed; }
.cost-window-table th, .cost-window-table td { white-space: normal; overflow-wrap: anywhere; }
.cost-window-table th:nth-child(1) { width: 90px; }
.cost-window-table th:nth-child(2) { width: 70px; }
.cost-window-table th:nth-child(3) { width: 100px; }
.cost-window-table th:nth-child(4) { width: 110px; }
.cost-window-table th:nth-child(5) { width: 180px; }
.cost-table-scroll { max-height: 460px; overflow: auto; }
/* cliproxy management.html iframe 嵌入 */
.cost-iframe-wrap { border: 1px solid var(--cost-line); background: var(--cost-panel); height: calc(100vh - 280px); min-height: 480px; }
.cost-cliproxy-manage { padding: 0; }
.cost-iframe { width: 100%; height: 100%; min-height: calc(100vh - 160px); border: 0; display: block; }
.cost-table { width: 100%; min-width: 880px; border-collapse: collapse; font-size: 11px; }
.cost-table th { position: sticky; top: 0; z-index: 2; height: 40px; padding: 0 12px; color: #77847a; background: #202720; border-bottom: 1px solid #2d352e; text-align: left; font-weight: 500; }
.cost-table th.num, .cost-table td.num { text-align: right; font-family: 'Cascadia Mono', Consolas, monospace; }
.cost-table td { padding: 9px 12px; border-bottom: 1px solid #293129; vertical-align: middle; }
.cost-table td strong { display: block; color: #e4e9e1; font: 600 11px 'Cascadia Mono', monospace; }
.cost-table td small { display: block; margin-top: 3px; color: #69756b; font: 9px 'Cascadia Mono', monospace; }
.cost-table tbody tr:hover { background: rgb(185 229 90 / 4%); }
.cost-emphasis { color: var(--cost-lime); font-weight: 700; }
.cost-badge { display: inline-block; padding: 3px 8px; font: 9px 'Cascadia Mono', monospace; border: 1px solid var(--cost-line-strong); }
.cost-badge.plan-plus { color: #c9a3e8; border-color: #6b4a8a; }
.cost-badge.plan-team { color: #79b6d9; border-color: #3a5a7a; }
.cost-badge.plan-API_KEY { color: var(--cost-gold); border-color: #7a6438; }
.cost-badge.plan-k12 { color: var(--cost-lime); border-color: #5a7a3a; }
.cost-badge.plan-unknown { color: var(--cost-muted); }
@media (max-width: 1180px) { .cost-unified-total { grid-template-columns: 1fr; } .cost-metric-grid--tokens { grid-template-columns: repeat(2, 1fr); } }

/* 账号导入区域 */
.cost-import-section { margin: 16px 0; padding: 16px; border: 1px solid var(--cost-line-strong); border-radius: 8px; background: var(--cost-bg-elevated, #111611); }
.cost-import-actions { display: flex; align-items: center; gap: 16px; margin-top: 12px; }
.cost-import-btn { display: inline-flex; align-items: center; gap: 8px; padding: 10px 20px; cursor: pointer; color: var(--cost-lime); background: #151a15; border: 1px solid #3e483f; border-radius: 6px; font: 12px 'Cascadia Mono', monospace; transition: all 0.15s; }
.cost-import-btn:hover { background: #1a201a; border-color: #5a6a4a; }
.cost-import-btn.is-loading { opacity: 0.7; cursor: wait; }
.cost-import-result { font: 11px 'Cascadia Mono', monospace; color: var(--cost-muted); }
.cost-import-result.is-success { color: var(--cost-lime); }

/* Keep the original one-row brand / workspace / tools structure. */
.cost-console .cost-toolbar{overflow:visible}
.cost-console .cost-toolbar{position:sticky;top:0;z-index:45;display:grid;grid-template-columns:minmax(180px,1fr) minmax(0,max-content) auto;grid-template-rows:auto;align-items:center;gap:12px;min-height:74px;padding:8px 14px;border-bottom:1px solid var(--cost-line-strong);background:rgb(13 17 14 / 96%);backdrop-filter:blur(10px)}
.cost-console:not(.cost-console--embedded) .cost-toolbar{grid-template-columns:minmax(180px,1fr) auto minmax(0,max-content) auto}
.cost-toolbar>.cost-back-button{height:34px;padding:0 8px;white-space:nowrap}.cost-toolbar>.cost-back-button svg{flex-shrink:0}
.cost-console .cost-brand-block{min-width:0;padding:0}.cost-brand-block h1{min-width:0;margin:4px 0 0;font-size:20px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.cost-brand-block p{line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cost-console .cost-workspaces{display:flex;flex-wrap:wrap;align-items:center;align-self:center;min-width:0;width:auto;max-width:100%;min-height:46px;gap:2px;padding:3px;overflow:visible;white-space:normal;border:1px solid var(--cost-line-strong);border-radius:var(--cost-radius-md);background:#121713}
.cost-workspaces button{display:inline-flex;align-items:center;justify-content:center;width:auto;min-width:96px;flex:0 0 auto;height:38px;gap:5px;padding:0 8px;border:0;border-radius:var(--cost-radius-sm);color:#8e998f;background:transparent;font-size:11px;white-space:nowrap;word-break:normal;overflow-wrap:normal}.cost-workspaces button.active{color:#10140f;background:var(--cost-lime);font-weight:700}.cost-workspaces .cost-workspaces__settings{color:#b8c5bb}.cost-workspaces .cost-workspaces__settings:hover{color:#10140f;background:#c8ed79}.cost-workspaces kbd{padding:1px 3px;border:1px solid currentColor;border-radius:4px;font:8px 'Cascadia Mono',monospace;opacity:.65}.cost-workspaces svg{flex-shrink:0}
.cost-console .cost-toolbar__actions{position:static;display:flex;align-items:center;justify-content:flex-end;flex-wrap:nowrap;gap:5px;min-width:0;width:auto;padding:0;overflow:visible}
.cost-toolbar__actions .cost-select-label{display:inline-flex;flex:0 0 auto;align-items:center;gap:5px;white-space:nowrap;font-size:10px}.cost-toolbar__actions .cost-select-label>span{white-space:nowrap;word-break:normal}.cost-toolbar__actions .cost-select-label select{width:118px;min-width:118px;height:34px;padding:0 22px 0 8px;font-size:11px}.cost-toolbar__actions .cost-tool-button{height:34px;flex:0 0 auto;padding:0 8px;font-size:11px;white-space:nowrap;word-break:normal}.cost-toolbar__actions .cost-icon-button{display:inline-flex;align-items:center;justify-content:center;width:34px;min-width:34px;max-width:34px;height:34px;flex:0 0 34px;padding:0}.cost-toolbar__actions svg{flex-shrink:0}.cost-toolbar__actions .cost-auto-refresh{width:82px;min-width:82px;justify-content:center;font-variant-numeric:tabular-nums}
.cost-toolbar__actions .cost-refresh-interval-label select{width:72px;min-width:72px}
.cost-model-basis>summary{padding:10px 16px;color:var(--cost-muted);font-size:11px;cursor:pointer;border-bottom:1px solid var(--cost-line)}
.cost-route-prices summary{cursor:pointer;color:var(--cost-blue);font-size:10px;line-height:1.6}.cost-route-prices>div{padding:7px 0;border-top:1px solid var(--cost-line);overflow-wrap:anywhere}
.cost-overview>.cost-provenance-strip{display:flex;flex-wrap:nowrap;align-items:stretch;gap:1px;margin-top:8px;overflow-x:auto}.cost-overview>.cost-provenance-strip>div{flex:1 0 210px;min-width:210px;grid-template-columns:16px minmax(0,1fr);gap:4px 7px;padding:8px 10px}.cost-overview>.cost-provenance-strip span{margin-top:0;line-height:1.5}
.cost-overview > .cost-provenance-strip > .cost-fee-settings { flex-basis: auto; min-width: max-content; }
.cost-fee-controls { white-space: nowrap; }
.cost-fee-controls .cost-rate-input { width: 46px; margin: 0 1px; font: inherit; }
.cost-fee-controls .cost-rate-input--multiplier { width: 40px; }
.cost-assets-row>.cost-metric-grid{grid-template-columns:repeat(4,minmax(0,1fr))}
.cost-unassigned-note{margin:6px 0;color:var(--cost-muted);font-size:10px}
@media(max-width:1600px){.cost-toolbar__actions>.cost-select-label>span{display:none}}
@media(max-width:1180px){.cost-console .cost-toolbar{grid-template-columns:180px minmax(120px,1fr) auto;gap:8px;padding:8px 10px}.cost-console:not(.cost-console--embedded) .cost-toolbar{grid-template-columns:180px auto minmax(120px,1fr) auto}.cost-toolbar>.cost-back-button{width:34px;padding:0;flex-shrink:0}.cost-toolbar>.cost-back-button>span{display:none}}
@media(max-width:760px){.cost-console .cost-toolbar{display:flex;overflow-x:auto}.cost-console .cost-brand-block{flex:0 0 150px}.cost-console .cost-workspaces{flex:0 0 auto}.cost-console .cost-toolbar__actions{flex:0 0 auto}.cost-brand-block h1{font-size:17px}.cost-brand-block p{display:none}.cost-assets-row>.cost-metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.cost-data-table .cost-col-select{width:60px}.cost-data-table .cost-col-account{width:250px}.cost-data-table .cost-col-status{width:135px}.cost-data-table .cost-col-quota{width:172px}.cost-data-table .cost-col-score{width:115px}.cost-data-table .cost-col-priority{width:76px}.cost-data-table .cost-col-date{width:132px}.cost-data-table .cost-col-amount{width:130px}.cost-data-table .cost-col-latency{width:112px}.cost-data-table .cost-col-state{width:150px}.cost-data-table .cost-col-groups{width:190px}.cost-data-table .cost-col-actions{width:86px}
</style>
