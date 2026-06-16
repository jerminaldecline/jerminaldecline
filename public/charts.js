/* jerminaldecline.com — chart rendering
   Extracted from index.html. Loaded as a plain <script> BEFORE the main
   script block, so these functions are defined in global scope before
   rebuild() calls them. Charts call formatting helpers (fmt, fmtDurStat,
   monthLabel, etc.) and read globals (monthlyData, chartMetric, viewMode,
   selectedChannel) that are declared in the main script — these resolve at
   call time (inside rebuild), not at parse time, so load order only requires
   this file to be parsed before the main block runs loadData(). */

function renderTrendChart(yoy) {
  const svg = document.getElementById('trendChart');
  const legend = document.getElementById('trendLegend');
  const tooltip = document.getElementById('chartTooltip');
  if (!monthlyData.length) {
    svg.innerHTML = '';
    legend.innerHTML = '';
    return;
  }

  // Exclude the current in-progress month from the *trend* (axis scale, YoY
  // comparison fills, prev-year line) — but include it as a separate visual
  // element so users can see "where we are right now" without it distorting
  // the comparison logic.
  const now = new Date();
  const currentMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const chartData = monthlyData.filter(m => m.key !== currentMonthKey);
  const inProgressMonth = monthlyData.find(m => m.key === currentMonthKey) || null;
  if (!chartData.length) {
    svg.innerHTML = '';
    legend.innerHTML = '';
    return;
  }

  // "All videos" mode: dedicated scatter chart, no lines. Branch here and
  // return early so the rest of the function (line/dual-axis rendering) doesn't run.
  const isAllVideosMode = chartMetric === 'all_videos'
    && viewMode === 'long'
    && channelQualifiesForLengthChart(selectedChannel);
  if (isAllVideosMode) {
    return renderAllVideosChart(chartData, inProgressMonth);
  }

  // "Like rate" mode: standalone single-line chart showing monthly long-form
  // like rate over time. The UI toggle for this was removed when "Views +
  // like rate" was added (the dual-axis chart shows the same rate with views
  // as visual context, strictly more informative). The dispatch and the
  // renderLikeRateChart function are kept in place so the mode can be
  // restored from a URL param or programmatic state without code changes
  // if we ever want it back. Currently unreachable from the chart toggle.
  const isLikeRateMode = chartMetric === 'like_rate'
    && viewMode === 'long'
    && selectedChannel !== 'ALL';
  if (isLikeRateMode) {
    return renderLikeRateChart(chartData, inProgressMonth);
  }

  // "Views + like rate" mode: dual-axis chart with views (left axis, count)
  // and like RATE (right axis, percentage). Same eligibility as the engagement
  // charts (single channel, long-form). Two lines together answer the
  // engagement-vs-magnitude question: did the loyal audience stay engaged as
  // total views collapsed, or did engagement fall in lockstep? Where rate
  // holds steady or rises while views fall = audience shrank but loyalty
  // remained; both falling together = audience cooled.
  const isViewsLikesMode = chartMetric === 'views_likes'
    && viewMode === 'long'
    && selectedChannel !== 'ALL';
  if (isViewsLikesMode) {
    return renderViewsLikesChart(chartData, inProgressMonth);
  }

  // "Engagement variance" mode: bar chart showing what FRACTION of each
  // month's videos qualified as high-engagement outliers (above the channel's
  // all-time p90 like rate). The narrative: in steady months, ~10% of videos
  // should naturally fall above p90 by definition. A sudden upswing — say
  // 40-50% of a month's videos beating that threshold — is a clear signal
  // that the audience's engagement profile has shifted. Same gating as the
  // other engagement charts (single channel, long-form).
  const isVarianceMode = chartMetric === 'engagement_variance'
    && viewMode === 'long'
    && selectedChannel !== 'ALL'
    && channelQualifiesForEngagementVariance(selectedChannel);
  if (isVarianceMode) {
    return renderEngagementVarianceChart(chartData, inProgressMonth);
  }

  // Are we in views+length mode? Only effective when:
  // - chartMetric is set to 'views_length'
  // - We're in long-form view (median duration is a long-form metric)
  // - The selected channel qualifies (sufficient consistent upload history)
  // - We have enough complete-month duration data points to plot
  const durations = chartData.map(m => m.curr.medianDuration || 0);
  const hasDurationData = durations.filter(d => d > 0).length >= 3;
  const showDuration = chartMetric === 'views_length'
    && viewMode === 'long'
    && channelQualifiesForLengthChart(selectedChannel)
    && hasDurationData;

  // In views+length mode, we suppress the YoY visual (deficit/surplus fills, prev-year line)
  // because two superimposed lines on dual axes plus the gap fill becomes noisy.
  // The view-history alone is the story; duration overlay is the story.
  const effectiveYoy = yoy && !showDuration;

  // Legend (gap-fill swatches added later, once we know which colours appear)
  let legendHtml = `
    <span class="trend-legend-item"><span class="trend-legend-swatch"></span> Views</span>
    ${effectiveYoy ? '<span class="trend-legend-item"><span class="trend-legend-swatch prev"></span> Previous year</span>' : ''}
    ${showDuration ? '<span class="trend-legend-item"><span class="trend-legend-swatch duration"></span> Median length</span>' : ''}
  `;

  // Layout — taller to accommodate annotation, more left padding for Y labels.
  // When the duration line is shown, also add right padding for the secondary Y axis labels.
  const W = 720, H = 280;
  const P = { top: 20, right: showDuration ? 66 : 24, bottom: 48, left: 66 };
  const innerW = W - P.left - P.right;
  const innerH = H - P.top - P.bottom;

  // Pull metric values (mode-aware via metricsFor)
  const currValues = chartData.map(m => metricsFor(m.curr).views);
  const prevValues = effectiveYoy ? chartData.map(m => m.yoy ? metricsFor(m.yoy).views : null) : [];

  // Y-axis max: tight to the data with 5% headroom, then round to a nice number.
  // Include the in-progress month's value if present so its dot stays inside the chart.
  // (Note: in-progress prev-year value is also factored in — it's a complete prior month.)
  const ipViewValue = inProgressMonth ? metricsFor(inProgressMonth.curr).views : null;
  const ipPrevViewValue = (inProgressMonth && effectiveYoy && inProgressMonth.yoy)
    ? metricsFor(inProgressMonth.yoy).views
    : null;
  const allValues = [
    ...currValues,
    ...prevValues.filter(v => v != null),
    ...(ipViewValue != null ? [ipViewValue] : []),
    ...(ipPrevViewValue != null ? [ipPrevViewValue] : [])
  ];
  const rawMax = Math.max(1, ...allValues);
  const yMax = niceMax(rawMax * 1.05);

  // X positions — we extend the X scale by one slot when there's an in-progress
  // month, so its data point sits naturally to the right of the last complete
  // month. The compression of the complete-month positions is negligible
  // (~1% for a typical 60-month range).
  const n = chartData.length;
  const nTotal = n + (inProgressMonth ? 1 : 0);
  const xFor = i => nTotal === 1 ? P.left + innerW / 2 : P.left + (i / (nTotal - 1)) * innerW;
  const yFor = v => P.top + (1 - v / yMax) * innerH;

  // Build path strings
  const currPath = currValues.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(v)}`).join(' ');

  // Duration line (only when in views+length mode). Uses a separate Y scale
  // mapped to the same vertical extent so both lines share the plot area but
  // each carries its own axis interpretation.
  let durPath = '';
  let durDots = '';
  let durTicks = [];
  let yForDur = null;
  let durMin = 0;
  let durMax = 0;
  if (showDuration) {
    const durValid = durations.filter(d => d > 0);
    // Also factor in the in-progress month's duration (if present) and its YoY counterpart
    // so the scale extends to accommodate them, not just the complete-month line.
    const ipDuration = inProgressMonth && inProgressMonth.curr.medianDuration > 0
      ? inProgressMonth.curr.medianDuration : null;
    const ipPrevDuration = inProgressMonth && inProgressMonth.yoy && inProgressMonth.yoy.medianDuration > 0
      ? inProgressMonth.yoy.medianDuration : null;
    const allDurations = [
      ...durValid,
      ...(ipDuration != null ? [ipDuration] : []),
      ...(ipPrevDuration != null ? [ipPrevDuration] : [])
    ];
    const durMaxRaw = Math.max(...allDurations);
    const durMinRaw = Math.min(...allDurations);
    // Round outward to human-readable multiples (e.g. whole minutes) so axis labels
    // like 11:00, 12:00, 13:00 land where they should — rather than mathematical
    // fifths like 11:28, 12:57 from a simple linear split.
    const axis = niceDurationAxis(durMinRaw, durMaxRaw);
    durMin = axis.min;
    durMax = axis.max;
    yForDur = v => P.top + (1 - (v - durMin) / (durMax - durMin)) * innerH;

    // Build path — break the line on zero/missing values
    let started = false;
    durations.forEach((d, i) => {
      if (d <= 0) { started = false; return; }
      durPath += `${started ? 'L' : 'M'} ${xFor(i)} ${yForDur(d)} `;
      started = true;
    });
    durDots = durations.map((d, i) =>
      d <= 0 ? '' : `<circle class="chart-dot duration" cx="${xFor(i)}" cy="${yForDur(d)}" r="2.8"/>`
    ).join('');

    // Right-axis tick labels — one per step from min to max inclusive.
    // This produces clean values like 11:00, 12:00, 13:00 rather than 11:28, 12:57.
    durTicks = [];
    for (let v = durMin; v <= durMax; v += axis.step) {
      durTicks.push({ y: yForDur(v), v });
    }
  }

  // Previous-year path — handle nulls by breaking the line.
  // Extends one slot beyond chartData to include the prev-year of the in-progress month
  // (which is a complete past month). The gap-fill polygons stay confined to complete-month
  // segments because the deficit/surplus comparison is misleading when one side is partial.
  let prevPath = '';
  if (effectiveYoy) {
    let started = false;
    prevValues.forEach((v, i) => {
      if (v == null) { started = false; return; }
      prevPath += `${started ? 'L' : 'M'} ${xFor(i)} ${yFor(v)} `;
      started = true;
    });
    // Append the in-progress prev-year point if present
    if (ipPrevViewValue != null) {
      const ipX = xFor(n);
      const ipY = yFor(ipPrevViewValue);
      prevPath += `${started ? 'L' : 'M'} ${ipX} ${ipY} `;
    }
  }

  // Directional gap fill — red segments where curr < prev (deficit), green where curr > prev (surplus).
  // Lines crossing between two consecutive months get split at the intersection so colours don't overlap.
  let gapSegmentsRed = '';
  let gapSegmentsGreen = '';
  if (effectiveYoy) {
    // Collect valid (both-defined) consecutive pairs into segment polygons
    function pushSegment(points, isDeficit) {
      if (points.length < 3) return;
      const path = `M ${points.map(p => `${p.x},${p.y}`).join(' L ')} Z`;
      if (isDeficit) gapSegmentsRed += path + ' ';
      else gapSegmentsGreen += path + ' ';
    }
    // Walk paired points, building per-interval quadrilaterals (or triangles at crossovers)
    for (let i = 0; i < n - 1; i++) {
      const p1 = prevValues[i], p2 = prevValues[i + 1];
      const c1 = currValues[i], c2 = currValues[i + 1];
      if (p1 == null || p2 == null || c1 == null || c2 == null) continue;
      const x1 = xFor(i), x2 = xFor(i + 1);
      const yp1 = yFor(p1), yp2 = yFor(p2);
      const yc1 = yFor(c1), yc2 = yFor(c2);
      // Difference between lines at each endpoint (positive = curr below prev = deficit)
      const d1 = yc1 - yp1;
      const d2 = yc2 - yp2;
      const sameSign = (d1 >= 0 && d2 >= 0) || (d1 <= 0 && d2 <= 0);
      if (sameSign) {
        // Whole interval is one colour
        const isDeficit = (d1 + d2) >= 0; // y grows downward → curr below = deficit
        pushSegment([
          { x: x1, y: yp1 }, { x: x2, y: yp2 },
          { x: x2, y: yc2 }, { x: x1, y: yc1 }
        ], isDeficit);
      } else {
        // Lines cross between i and i+1: find the intersection x and split
        // Parametric: at fraction t (0..1), prev = yp1 + t*(yp2-yp1), curr = yc1 + t*(yc2-yc1)
        // Intersection where prev == curr: yp1 + t*(yp2-yp1) = yc1 + t*(yc2-yc1)
        // → t = (yc1 - yp1) / ((yp2 - yp1) - (yc2 - yc1))
        const denom = (yp2 - yp1) - (yc2 - yc1);
        const t = denom !== 0 ? (yc1 - yp1) / denom : 0.5;
        const tt = Math.max(0, Math.min(1, t));
        const xCross = x1 + tt * (x2 - x1);
        const yCross = yp1 + tt * (yp2 - yp1); // = yc at crossover
        // Left half: from i to crossover
        const leftIsDeficit = d1 > 0;
        pushSegment([
          { x: x1, y: yp1 }, { x: xCross, y: yCross },
          { x: x1, y: yc1 }
        ], leftIsDeficit);
        // Right half: from crossover to i+1
        const rightIsDeficit = d2 > 0;
        pushSegment([
          { x: xCross, y: yCross }, { x: x2, y: yp2 },
          { x: x2, y: yc2 }
        ], rightIsDeficit);
      }
    }
  }

  // Append deficit/surplus swatches to legend based on what's actually rendered
  if (gapSegmentsRed) legendHtml += '<span class="trend-legend-item"><span class="trend-legend-swatch gap deficit"></span> YoY deficit</span>';
  if (gapSegmentsGreen) legendHtml += '<span class="trend-legend-item"><span class="trend-legend-swatch gap surplus"></span> YoY surplus</span>';
  legend.innerHTML = legendHtml;

  // Y axis grid + labels
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => ({ y: yFor(t * yMax), v: t * yMax }));
  const gridLines = yTicks.map(t => `
    <line class="chart-grid-line" x1="${P.left}" y1="${t.y}" x2="${P.left + innerW}" y2="${t.y}"/>
    <text class="chart-axis-label y" x="${P.left - 8}" y="${t.y + 4}">${fmtCompact(t.v)}</text>
  `).join('');

  // X axis labels — strategy depends on range
  // chartData[i].label is like "Jan 2025"; we parse month + year out of it
  const years = new Set(chartData.map(m => m.label.split(' ')[1]));
  const spansMultipleYears = years.size > 1;
  let xLabels;
  if (spansMultipleYears && n > 24) {
    // Long range: one label per year, positioned at the first month of that year
    // (or at i=0 if the range starts mid-year)
    const yearFirstIdx = new Map();
    chartData.forEach((m, i) => {
      const year = m.label.split(' ')[1];
      if (!yearFirstIdx.has(year)) yearFirstIdx.set(year, i);
    });
    xLabels = [...yearFirstIdx.entries()].map(([year, i]) =>
      `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}">${year}</text>`
    ).join('');
  } else if (spansMultipleYears) {
    // Medium range (~12-24 months): show month + abbreviated year on first label of each year,
    // month-only elsewhere
    const labelStride = n <= 13 ? 1 : Math.max(1, Math.ceil(n / 6));
    const yearsSeen = new Set();
    xLabels = chartData.map((m, i) => {
      if (i % labelStride !== 0 && i !== n - 1) return '';
      const [mon, year] = m.label.split(' ');
      const yearShort = "'" + year.slice(2);
      const showYear = !yearsSeen.has(year);
      yearsSeen.add(year);
      const text = showYear ? `${mon} ${yearShort}` : mon;
      return `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}">${text}</text>`;
    }).join('');
  } else {
    // Single year: just month abbreviations as before
    const labelStride = n <= 13 ? 1 : Math.max(1, Math.ceil(n / 6));
    xLabels = chartData.map((m, i) => {
      if (i % labelStride !== 0 && i !== n - 1) return '';
      return `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}">${m.label.split(' ')[0]}</text>`;
    }).join('');
  }

  // Dots — every point is now a complete month, render uniformly
  const currDots = currValues.map((v, i) =>
    `<circle class="chart-dot curr" cx="${xFor(i)}" cy="${yFor(v)}" r="3.5"/>`
  ).join('');
  const prevDots = effectiveYoy ? prevValues.map((v, i) =>
    v == null ? '' : `<circle class="chart-dot prev" cx="${xFor(i)}" cy="${yFor(v)}" r="3"/>`
  ).join('') : '';
  // Prev-year dot at the in-progress slot too (so the prev-year line ends with a dot
  // at the same X as the in-progress dot for visual consistency)
  const ipPrevDot = effectiveYoy && ipPrevViewValue != null
    ? `<circle class="chart-dot prev" cx="${xFor(n)}" cy="${yFor(ipPrevViewValue)}" r="3"/>`
    : '';

  // Attribution: bottom-right corner of the chart area
  // On narrow viewports, use a more compact form so the text doesn't overflow
  const channelName = activeDisplayName();
  const startEl = document.getElementById('startDate');
  const endEl = document.getElementById('endDate');
  const dateRange = startEl && endEl ? `${startEl.value} – ${endEl.value}` : '';
  const isNarrow = window.matchMedia('(max-width: 540px)').matches;
  const attributionText = isNarrow
    ? `${channelName} · jerminaldecline.com`
    : `${channelName} · ${dateRange} · jerminaldecline.com`;
  const attribution = `
    <text class="chart-attribution" x="${P.left + innerW}" y="${H - 8}">
      ${escapeHtml(attributionText)}
    </text>
  `;

  // Hit areas
  const hitWidth = innerW / Math.max(1, nTotal);
  const hits = chartData.map((m, i) => `
    <rect class="chart-hit"
      x="${xFor(i) - hitWidth / 2}" y="${P.top}"
      width="${hitWidth}" height="${innerH}"
      data-idx="${i}"/>
  `).join('');

  // Right-axis labels for duration scale (only when showDuration is true)
  const durLabelsSvg = showDuration ? durTicks.map(t =>
    `<text class="chart-axis-label y dur" x="${P.left + innerW + 8}" y="${t.y + 4}">${fmtDurStat(t.v)}</text>`
  ).join('') : '';

  // In-progress month rendering:
  // - Dashed connector from the last complete month to the in-progress dot
  // - Pulsing red dot at the in-progress data point
  // - Dedicated hit area for the tooltip
  // The dot uses two stacked circles: a static red ring and an expanding/fading
  // pulse ring that loops via CSS animation.
  let inProgressSvg = '';
  let inProgressHits = '';
  if (inProgressMonth) {
    const ipIdx = n;  // sits at index = n in the extended X scale
    const ipX = xFor(ipIdx);
    const ipMetrics = metricsFor(inProgressMonth.curr);
    const ipViews = ipMetrics.views;
    const ipY = yFor(ipViews);
    // Connector for views line — dashed
    const lastCompleteY = yFor(currValues[n - 1]);
    const lastCompleteX = xFor(n - 1);
    const viewsConnector = `<path class="chart-line-inprogress" d="M ${lastCompleteX} ${lastCompleteY} L ${ipX} ${ipY}"/>`;

    // Connector + dot for duration line if in views+length mode
    let durInProgressSvg = '';
    if (showDuration && yForDur) {
      const ipDur = inProgressMonth.curr.medianDuration || 0;
      if (ipDur > 0) {
        // Find the last complete month that had duration data, for the dashed connector
        let lastDurIdx = -1;
        for (let i = n - 1; i >= 0; i--) {
          if (durations[i] > 0) { lastDurIdx = i; break; }
        }
        if (lastDurIdx >= 0) {
          const lastDurX = xFor(lastDurIdx);
          const lastDurY = yForDur(durations[lastDurIdx]);
          const ipDurY = yForDur(ipDur);
          durInProgressSvg = `
            <path class="chart-line-inprogress dur" d="M ${lastDurX} ${lastDurY} L ${ipX} ${ipDurY}"/>
            <circle class="chart-dot-inprogress dur" cx="${ipX}" cy="${ipDurY}" r="4"/>
            <circle class="chart-dot-inprogress-pulse dur" cx="${ipX}" cy="${ipDurY}" r="4"/>
          `;
        }
      }
    }

    inProgressSvg = `
      ${viewsConnector}
      ${durInProgressSvg}
      <circle class="chart-dot-inprogress" cx="${ipX}" cy="${ipY}" r="4.5"/>
      <circle class="chart-dot-inprogress-pulse" cx="${ipX}" cy="${ipY}" r="4.5"/>
    `;
    inProgressHits = `
      <rect class="chart-hit"
        x="${ipX - hitWidth / 2}" y="${P.top}"
        width="${hitWidth}" height="${innerH}"
        data-idx="-1"
        data-inprogress="1"/>
    `;
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <line class="chart-axis-line" x1="${P.left}" y1="${P.top + innerH}" x2="${P.left + innerW}" y2="${P.top + innerH}"/>
    ${gridLines}
    ${xLabels}
    ${durLabelsSvg}
    ${gapSegmentsRed ? `<path class="chart-gap deficit" d="${gapSegmentsRed}"/>` : ''}
    ${gapSegmentsGreen ? `<path class="chart-gap surplus" d="${gapSegmentsGreen}"/>` : ''}
    ${effectiveYoy && prevPath ? `<path class="chart-line-prev" d="${prevPath}"/>` : ''}
    <path class="chart-line-curr" d="${currPath}"/>
    ${showDuration && durPath ? `<path class="chart-line-duration" d="${durPath}"/>` : ''}
    ${prevDots}
    ${ipPrevDot}
    ${currDots}
    ${showDuration ? durDots : ''}
    ${inProgressSvg}
    ${attribution}
    ${hits}
    ${inProgressHits}
  `;

  // Tooltip behaviour
  svg.querySelectorAll('.chart-hit').forEach(rect => {
    rect.addEventListener('mouseenter', e => showTooltip(parseInt(rect.dataset.idx)));
    rect.addEventListener('touchstart', e => { e.preventDefault(); showTooltip(parseInt(rect.dataset.idx)); }, { passive: false });
    rect.addEventListener('mouseleave', hideTooltip);
  });
  svg.addEventListener('mouseleave', hideTooltip);

  function showTooltip(idx) {
    // idx === -1 means the in-progress month hit
    const isInProgress = idx === -1;
    const m = isInProgress ? inProgressMonth : chartData[idx];
    if (!m) return;
    const curr = metricsFor(m.curr);
    const yoyM = m.yoy ? metricsFor(m.yoy) : null;
    const xIdx = isInProgress ? n : idx;
    const cxPct = ((xFor(xIdx) / W) * 100);
    const cyPct = ((yFor(curr.views) / H) * 100);
    let deltaHtml = '';
    // Suppress YoY delta for the in-progress month — comparing partial-current
    // to full-previous-year is misleading without proportional adjustment.
    if (!isInProgress && effectiveYoy && yoyM && yoyM.views > 0) {
      const pct = ((curr.views - yoyM.views) / yoyM.views) * 100;
      const cls = pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : '';
      const arrowSym = pct > 0.5 ? '▲' : pct < -0.5 ? '▼' : '·';
      deltaHtml = `<span class="chart-tooltip-delta ${cls}">${arrowSym} ${Math.abs(pct).toFixed(1)}%</span>`;
    }
    // Duration row appears only in views+length mode
    const durSec = m.curr.medianDuration;
    let durationHtml = '';
    if (showDuration && durSec > 0) {
      let durDeltaHtml = '';
      // Show duration change vs the previous MONTH (not previous year).
      // The whole story we're telling is the recent step-change: median length
      // hovered around 12 minutes for years, then spiked in the last few months.
      // Year-over-year would mask that — flat baselines vs flat baselines hide
      // the spike. Month-on-month reveals it: hover May to see how it jumped
      // from April; hover June to see how it jumped from May.
      if (m.mom && m.mom.medianDuration > 0) {
        const pct = ((durSec - m.mom.medianDuration) / m.mom.medianDuration) * 100;
        const arrowSym = pct > 0.5 ? '▲' : pct < -0.5 ? '▼' : '·';
        // Label the comparison explicitly so the arrow can't be misread as
        // referring to the chart line's local slope (it's a specific value, not direction).
        const prevMonthLabel = monthLabel(prevMonthKey(m.key));
        durDeltaHtml = `<span class="chart-tooltip-delta">${arrowSym} ${Math.abs(pct).toFixed(1)}% <span class="chart-tooltip-delta-ref">vs ${prevMonthLabel}</span></span>`;
      }
      durationHtml = `<div class="chart-tooltip-row"><span class="swatch duration"></span> ${fmtDurStat(durSec)} median length ${durDeltaHtml}</div>`;
    }
    // In-progress caveat — clarifies which numbers are partial and which aren't.
    // Views are cumulative and incomplete; duration medians are real numbers.
    const inProgressCaveat = isInProgress
      ? `<div class="chart-tooltip-inprogress">In progress — views are partial; length is a running median.</div>`
      : '';
    tooltip.innerHTML = `
      <div class="chart-tooltip-month">${m.label}${isInProgress ? ' <span class="chart-tooltip-inprogress-tag">live</span>' : ''}</div>
      <div class="chart-tooltip-row"><span class="swatch curr"></span> ${fmt(curr.views)} ${deltaHtml}</div>
      ${!isInProgress && effectiveYoy && yoyM ? `<div class="chart-tooltip-row"><span class="swatch prev"></span> ${fmt(yoyM.views)} <span style="color:var(--text-dim);font-size:0.75rem;">(${m.label.split(' ')[0]} ${parseInt(m.label.split(' ')[1]) - 1})</span></div>` : ''}
      ${durationHtml}
      ${inProgressCaveat}
    `;
    tooltip.style.display = 'block';
    tooltip.style.left = cxPct + '%';
    tooltip.style.top = cyPct + '%';
    // After render, nudge horizontally if tooltip would overflow the wrap
    requestAnimationFrame(() => {
      const wrap = svg.parentElement;
      const wrapRect = wrap.getBoundingClientRect();
      const tipRect = tooltip.getBoundingClientRect();
      let offset = 0;
      if (tipRect.left < wrapRect.left + 4) offset = (wrapRect.left + 4) - tipRect.left;
      else if (tipRect.right > wrapRect.right - 4) offset = (wrapRect.right - 4) - tipRect.right;
      if (offset !== 0) {
        tooltip.style.transform = `translate(calc(-50% + ${offset}px), -100%)`;
      } else {
        tooltip.style.transform = '';
      }
    });
  }
  function hideTooltip() { tooltip.style.display = 'none'; }
}

// Dedicated scatter chart — every long-form video as a dot at (publishDate, duration).
// No lines, no YoY comparison, no median overlay. This is the raw-data view: the
// median trend chart describes what's happening; this view shows you every video
// Monthly long-form like rate over time. Single-line chart with a percentage
// Y-axis. Mirrors the views chart's structure (in-progress connector, three
// X-axis strategies by range size, tightNiceAxis Y) so the two charts feel
// visually consistent — useful when comparing views and like-rate side-by-side.
//
// Single channel only — channels have different baseline like rates (median
// 7.6% for TheQuartering vs 11.2% for JeremyHambly), so blending them into
// a single "All" line would be statistically meaningless. The toggle button
// is hidden for ALL view; this function is only reached for a specific channel.
//
// The point of the chart: the user wants to see whether engagement RATE has
// changed alongside the audience size. A flat like rate while views collapse
// means the remaining audience is still as engaged (loyalty held); a falling
// rate means the audience cooled too (engagement collapsed with attention).
function renderLikeRateChart(chartData, inProgressMonth) {
  const svg = document.getElementById('trendChart');
  const legend = document.getElementById('trendLegend');
  const tooltip = document.getElementById('chartTooltip');
  if (tooltip) tooltip.style.display = 'none';

  legend.innerHTML = `
    <span class="trend-legend-item"><span class="trend-legend-swatch likerate"></span> Long-form like rate (likes ÷ views)</span>
  `;

  // Layout — same dimensions as the views chart for visual consistency.
  const W = 720, H = 280;
  const P = { top: 20, right: 24, bottom: 48, left: 56 };
  const innerW = W - P.left - P.right;
  const innerH = H - P.top - P.bottom;
  const n = chartData.length;
  const nTotal = n + (inProgressMonth ? 1 : 0);

  // Hide chart for too-few data points — a single point is meaningless and a
  // single-segment line tells no story.
  if (n < 2) {
    svg.innerHTML = '';
    return;
  }

  // Build [{key, rate}] with rates as percentages (0-100).
  const rates = chartData.map(m => ({
    key: m.key,
    rate: (m.curr.longLikeRate || 0) * 100
  }));
  const ipRate = inProgressMonth ? (inProgressMonth.curr.longLikeRate || 0) * 100 : null;

  // Y axis — anchor to data range. Unlike revenue/views which start at 0,
  // like rate is bounded between ~3-15% for these channels. Forcing y=0 would
  // compress the meaningful variation into the top 10% of the chart and hide
  // the story. Instead, pad the rate range with a small margin and use
  // tightNiceAxis for both ends.
  const allRates = [...rates.map(r => r.rate), ipRate].filter(v => v != null && v > 0);
  if (allRates.length < 2) {
    svg.innerHTML = '';
    return;
  }
  const minRate = Math.min(...allRates);
  const maxRate = Math.max(...allRates);
  // Pad ~10% above and below the data range so the line doesn't kiss the axes.
  const pad = Math.max(0.5, (maxRate - minRate) * 0.15);
  const yBottom = Math.max(0, minRate - pad);
  const yTopRaw = maxRate + pad;
  const axis = tightNiceAxis(yTopRaw);
  const yMax = axis.max;
  const yStep = axis.step;
  // Floor on the bottom to a multiple of step so labels still align nicely
  const yMin = Math.max(0, Math.floor(yBottom / yStep) * yStep);

  const xFor = (i) => P.left + (nTotal === 1 ? innerW / 2 : (i / (nTotal - 1)) * innerW);
  const yFor = (v) => P.top + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Y grid + labels — driven by step so ticks land on clean values.
  let gridLines = '', yLabels = '';
  for (let v = yMin; v <= yMax + 0.001; v += yStep) {
    const y = yFor(v);
    gridLines += `<line class="chart-grid-line" x1="${P.left}" y1="${y}" x2="${W - P.right}" y2="${y}" />`;
    yLabels += `<text class="chart-axis-label y" x="${P.left - 8}" y="${y + 4}" text-anchor="end">${v.toFixed(yStep < 1 ? 1 : 0)}%</text>`;
  }

  // X axis labels — three strategies, identical logic to renderRevenueChart.
  const years = new Set(chartData.map(m => m.key.slice(0, 4)));
  const spansMultipleYears = years.size > 1;
  let xLabels = '';
  function monthShort(key) {
    const [, mo] = key.split('-').map(Number);
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mo - 1];
  }
  if (spansMultipleYears && n > 24) {
    const yearFirstIdx = new Map();
    chartData.forEach((m, i) => {
      const y = m.key.slice(0, 4);
      if (!yearFirstIdx.has(y)) yearFirstIdx.set(y, i);
    });
    for (const [year, i] of yearFirstIdx.entries()) {
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${year}</text>`;
    }
  } else if (spansMultipleYears) {
    const labelStride = n <= 13 ? 1 : Math.max(1, Math.ceil(n / 6));
    const yearsSeen = new Set();
    for (let i = 0; i < n; i++) {
      if (i % labelStride !== 0 && i !== n - 1) continue;
      const year = chartData[i].key.slice(0, 4);
      const mon = monthShort(chartData[i].key);
      const showYear = !yearsSeen.has(year);
      yearsSeen.add(year);
      const text = showYear ? `${mon} '${year.slice(2)}` : mon;
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${text}</text>`;
    }
  } else {
    const labelStride = n <= 13 ? 1 : Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i++) {
      if (i % labelStride !== 0 && i !== n - 1) continue;
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${monthShort(chartData[i].key)}</text>`;
    }
  }

  // Build line path. Skip months where the rate is 0 (no data or zero likes
  // hidden by YouTube) — the line "lifts" over those gaps rather than
  // collapsing visibly to 0%.
  let linePath = '';
  let lastValid = -1;
  for (let i = 0; i < n; i++) {
    const r = rates[i].rate;
    if (r <= 0) continue;
    const x = xFor(i);
    const y = yFor(r);
    linePath += `${lastValid < 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    lastValid = i;
  }

  // Hover targets for tooltip
  let hovers = '';
  const wHover = innerW / Math.max(1, nTotal - 1);
  for (let i = 0; i < n; i++) {
    const x = xFor(i);
    hovers += `<rect class="chart-hit" x="${x - wHover / 2}" y="${P.top}" width="${wHover}" height="${innerH}" data-idx="${i}" />`;
  }

  // In-progress month — dot + dashed connector from last complete month
  let ipDot = '';
  let ipConnector = '';
  if (inProgressMonth && ipRate != null && ipRate > 0 && lastValid >= 0) {
    const x = xFor(n);
    const y = yFor(ipRate);
    const lastX = xFor(lastValid);
    const lastY = yFor(rates[lastValid].rate);
    ipConnector = `<path class="chart-line-likerate-inprogress" d="M ${lastX} ${lastY} L ${x} ${y}" />`;
    ipDot = `<circle class="chart-dot-likerate-inprogress-pulse" cx="${x}" cy="${y}" r="4" /><circle class="chart-dot-likerate-inprogress" cx="${x}" cy="${y}" r="4" />`;
    hovers += `<rect class="chart-hit" x="${x - wHover / 2}" y="${P.top}" width="${wHover}" height="${innerH}" data-idx="ip" />`;
  }

  svg.innerHTML = `
    ${gridLines}
    <path class="chart-line-likerate" d="${linePath}" />
    ${ipConnector}
    ${ipDot}
    ${xLabels}
    ${yLabels}
    ${hovers}
  `;

  // Tooltip — shows month, like rate, raw likes/views breakdown
  const wrapEl = document.getElementById('chartWrap');
  svg.querySelectorAll('.chart-hit').forEach(rect => {
    rect.addEventListener('mouseenter', () => {
      const idx = rect.getAttribute('data-idx');
      const m = idx === 'ip' ? inProgressMonth : chartData[Number(idx)];
      if (!m) return;
      const bbox = rect.getBoundingClientRect();
      const wrap = wrapEl.getBoundingClientRect();
      tooltip.style.display = 'block';
      const rate = (m.curr.longLikeRate || 0) * 100;
      tooltip.innerHTML = `
        <div class="tooltip-month">${monthLabel(m.key)}${idx === 'ip' ? ' <span class="tooltip-tag">in progress</span>' : ''}</div>
        <div class="tooltip-row"><strong>${rate.toFixed(2)}%</strong> like rate</div>
        <div class="tooltip-row tooltip-detail">${fmt(m.curr.longLikes || 0)} likes / ${fmtCompact(m.curr.longViews || 0)} views</div>
      `;
      // Clamp horizontal position to keep tooltip inside the wrap
      const desired = bbox.left - wrap.left + bbox.width / 2;
      const tipWidth = tooltip.offsetWidth || 200;
      const margin = 8;
      const half = tipWidth / 2;
      const minLeft = half + margin;
      const maxLeft = wrap.width - half - margin;
      const clamped = Math.max(minLeft, Math.min(maxLeft, desired));
      tooltip.style.left = clamped + 'px';
      tooltip.style.top = (bbox.top - wrap.top - 8) + 'px';
    });
    rect.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  });
}

// Dual-axis chart: views (left axis, accent) and like rate (right axis, purple).
// Two independent Y axes — left scaled 0 → niceMax for views (counts have a
// natural zero), right scaled to the like rate's actual data range (rate is
// bounded ~3-15% so zeroing the axis would compress all the meaningful
// variation into the top of the chart). The pairing answers a specific
// question: did engagement quality hold up while audience size collapsed?
// If the lines diverge — views dropping while rate holds steady or rises —
// the loyal-audience-staying story is in play.
//
// Same eligibility as the standalone like rate chart (single channel,
// long-form). Hidden from the toggle for ALL view or Shorts mode.
function renderViewsLikesChart(chartData, inProgressMonth) {
  const svg = document.getElementById('trendChart');
  const legend = document.getElementById('trendLegend');
  const tooltip = document.getElementById('chartTooltip');
  if (tooltip) tooltip.style.display = 'none';

  legend.innerHTML = `
    <span class="trend-legend-item"><span class="trend-legend-swatch"></span> Long-form views (left axis)</span>
    <span class="trend-legend-item"><span class="trend-legend-swatch likerate"></span> Like rate (right axis, %)</span>
  `;

  // Layout — both axes need label space, so increase the right padding to
  // accommodate the right-side Y labels.
  const W = 720, H = 280;
  const P = { top: 20, right: 56, bottom: 48, left: 56 };
  const innerW = W - P.left - P.right;
  const innerH = H - P.top - P.bottom;
  const n = chartData.length;
  const nTotal = n + (inProgressMonth ? 1 : 0);

  if (n < 2) {
    svg.innerHTML = '';
    return;
  }

  // Extract series
  const views = chartData.map(m => m.curr.longViews || 0);
  // Like rates as percentages (0-100). Skip months with zero views (rate
  // would be 0/0; the line lifts over those gaps rather than dropping to 0%).
  const rates = chartData.map(m => (m.curr.longLikeRate || 0) * 100);
  const ipViews = inProgressMonth ? (inProgressMonth.curr.longViews || 0) : null;
  const ipRate = inProgressMonth ? (inProgressMonth.curr.longLikeRate || 0) * 100 : null;

  // Left axis (views): anchored at 0. Use niceMax with 5% headroom — matches
  // the existing views chart's behaviour.
  const allViews = [...views, ipViews].filter(v => v != null && v >= 0);
  const vMax = niceMax(Math.max(1, ...allViews) * 1.05);

  // Right axis (like rate): NOT anchored at 0. Rate hangs in a narrow band
  // (~3-15% for these channels) so zero-anchoring would crush variation into
  // the top of the chart. Pad above/below data range and use tightNiceAxis.
  const allRates = [...rates, ipRate].filter(v => v != null && v > 0);
  if (allRates.length < 2) {
    svg.innerHTML = '';
    return;
  }
  const minRate = Math.min(...allRates);
  const maxRate = Math.max(...allRates);
  const ratePad = Math.max(0.5, (maxRate - minRate) * 0.15);
  const rateAxis = tightNiceAxis(maxRate + ratePad);
  const rMax = rateAxis.max;
  const rStep = rateAxis.step;
  const rMin = Math.max(0, Math.floor(Math.max(0, minRate - ratePad) / rStep) * rStep);

  const xFor = (i) => P.left + (nTotal === 1 ? innerW / 2 : (i / (nTotal - 1)) * innerW);
  const yForViews = (v) => P.top + innerH - (v / vMax) * innerH;
  const yForRate = (v) => P.top + innerH - ((v - rMin) / (rMax - rMin)) * innerH;

  // Grid lines + axis labels.
  //
  // Left axis (views) uses fixed 5-tick spacing for clean compact labels.
  // Right axis (rate) uses tightNiceAxis's step so its ticks land on clean
  // percentage values — and we DON'T draw gridlines from the right axis,
  // because two sets of gridlines would clash visually. Right axis ticks
  // just append labels at their natural positions.
  let gridLines = '', yLabelsLeft = '', yLabelsRight = '';
  const TICK_COUNT = 5;
  for (let i = 0; i <= TICK_COUNT; i++) {
    const y = P.top + innerH * (1 - i / TICK_COUNT);
    gridLines += `<line class="chart-grid-line" x1="${P.left}" y1="${y}" x2="${W - P.right}" y2="${y}" />`;
    const vVal = (vMax / TICK_COUNT) * i;
    yLabelsLeft += `<text class="chart-axis-label y" x="${P.left - 8}" y="${y + 4}" text-anchor="end">${fmtCompact(vVal)}</text>`;
  }
  // Right axis labels at clean percentage steps
  for (let v = rMin; v <= rMax + 0.001; v += rStep) {
    const y = yForRate(v);
    yLabelsRight += `<text class="chart-axis-label y" x="${W - P.right + 8}" y="${y + 4}" text-anchor="start">${v.toFixed(rStep < 1 ? 1 : 0)}%</text>`;
  }

  // X axis labels — three strategies, same as the other charts
  const years = new Set(chartData.map(m => m.key.slice(0, 4)));
  const spansMultipleYears = years.size > 1;
  let xLabels = '';
  function monthShort(key) {
    const [, mo] = key.split('-').map(Number);
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mo - 1];
  }
  if (spansMultipleYears && n > 24) {
    const yearFirstIdx = new Map();
    chartData.forEach((m, i) => {
      const y = m.key.slice(0, 4);
      if (!yearFirstIdx.has(y)) yearFirstIdx.set(y, i);
    });
    for (const [year, i] of yearFirstIdx.entries()) {
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${year}</text>`;
    }
  } else if (spansMultipleYears) {
    const labelStride = n <= 13 ? 1 : Math.max(1, Math.ceil(n / 6));
    const yearsSeen = new Set();
    for (let i = 0; i < n; i++) {
      if (i % labelStride !== 0 && i !== n - 1) continue;
      const year = chartData[i].key.slice(0, 4);
      const mon = monthShort(chartData[i].key);
      const showYear = !yearsSeen.has(year);
      yearsSeen.add(year);
      const text = showYear ? `${mon} '${year.slice(2)}` : mon;
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${text}</text>`;
    }
  } else {
    const labelStride = n <= 13 ? 1 : Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i++) {
      if (i % labelStride !== 0 && i !== n - 1) continue;
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${monthShort(chartData[i].key)}</text>`;
    }
  }

  // Build the two line paths. Views line is continuous; rate line skips
  // months with zero data (line "lifts" over those gaps rather than dipping
  // to 0%).
  let viewsPath = '', ratePath = '';
  let lastValidRate = -1;
  for (let i = 0; i < n; i++) {
    const x = xFor(i);
    viewsPath += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${yForViews(views[i]).toFixed(1)}`;
    if (rates[i] > 0) {
      ratePath += `${lastValidRate < 0 ? 'M' : 'L'}${x.toFixed(1)},${yForRate(rates[i]).toFixed(1)}`;
      lastValidRate = i;
    }
  }

  // Hover targets
  let hovers = '';
  const wHover = innerW / Math.max(1, nTotal - 1);
  for (let i = 0; i < n; i++) {
    const x = xFor(i);
    hovers += `<rect class="chart-hit" x="${x - wHover / 2}" y="${P.top}" width="${wHover}" height="${innerH}" data-idx="${i}" />`;
  }

  // Data points — one dot per month on each line, for visual consistency with
  // the views chart and so users can see exactly where the data lives.
  let viewsDots = '', rateDots = '';
  for (let i = 0; i < n; i++) {
    const x = xFor(i);
    viewsDots += `<circle class="chart-dot curr" cx="${x}" cy="${yForViews(views[i]).toFixed(1)}" r="3.5" />`;
    if (rates[i] > 0) {
      rateDots += `<circle class="chart-dot likerate" cx="${x}" cy="${yForRate(rates[i]).toFixed(1)}" r="3.5" />`;
    }
  }

  // Site attribution — same format as the other charts. Channel name + date
  // range + domain, with a narrow-viewport fallback.
  const channelName = activeDisplayName();
  const startEl = document.getElementById('startDate');
  const endEl = document.getElementById('endDate');
  const dateRange = startEl && endEl ? `${startEl.value} – ${endEl.value}` : '';
  const isNarrow = window.matchMedia('(max-width: 540px)').matches;
  const attributionText = isNarrow
    ? `${channelName} · jerminaldecline.com`
    : `${channelName} · ${dateRange} · jerminaldecline.com`;
  const attribution = `
    <text class="chart-attribution" x="${P.left + innerW}" y="${H - 8}" text-anchor="end">
      ${escapeHtml(attributionText)}
    </text>
  `;

  // In-progress month — two dots, two connectors (one per line)
  let ipDotViews = '', ipDotRate = '', ipConnectorViews = '', ipConnectorRate = '';
  if (inProgressMonth) {
    const x = xFor(n);
    const lastIdx = n - 1;
    const lastX = xFor(lastIdx);
    const yV = yForViews(ipViews);
    const lastYV = yForViews(views[lastIdx]);
    ipConnectorViews = `<path class="chart-line-inprogress" d="M ${lastX} ${lastYV} L ${x} ${yV}" />`;
    ipDotViews = `<circle class="chart-dot-inprogress-pulse" cx="${x}" cy="${yV}" r="4" /><circle class="chart-dot-inprogress" cx="${x}" cy="${yV}" r="4" />`;
    // Rate dot only renders if there's an in-progress rate AND a prior valid
    // rate point to draw the dashed connector from.
    if (ipRate != null && ipRate > 0 && lastValidRate >= 0) {
      const yR = yForRate(ipRate);
      const lastYR = yForRate(rates[lastValidRate]);
      ipConnectorRate = `<path class="chart-line-likerate-inprogress" d="M ${xFor(lastValidRate)} ${lastYR} L ${x} ${yR}" />`;
      ipDotRate = `<circle class="chart-dot-likerate-inprogress-pulse" cx="${x}" cy="${yR}" r="4" /><circle class="chart-dot-likerate-inprogress" cx="${x}" cy="${yR}" r="4" />`;
    }
    hovers += `<rect class="chart-hit" x="${x - wHover / 2}" y="${P.top}" width="${wHover}" height="${innerH}" data-idx="ip" />`;
  }

  svg.innerHTML = `
    ${gridLines}
    <path class="chart-line-curr" d="${viewsPath}" />
    <path class="chart-line-likerate" d="${ratePath}" />
    ${viewsDots}
    ${rateDots}
    ${ipConnectorViews}
    ${ipConnectorRate}
    ${ipDotViews}
    ${ipDotRate}
    ${xLabels}
    ${yLabelsLeft}
    ${yLabelsRight}
    ${attribution}
    ${hovers}
  `;

  // Tooltip — shows month, views, like rate, raw counts
  const wrapEl = document.getElementById('chartWrap');
  svg.querySelectorAll('.chart-hit').forEach(rect => {
    rect.addEventListener('mouseenter', () => {
      const idx = rect.getAttribute('data-idx');
      const m = idx === 'ip' ? inProgressMonth : chartData[Number(idx)];
      if (!m) return;
      const bbox = rect.getBoundingClientRect();
      const wrap = wrapEl.getBoundingClientRect();
      tooltip.style.display = 'block';
      const rate = (m.curr.longLikeRate || 0) * 100;
      tooltip.innerHTML = `
        <div class="tooltip-month">${monthLabel(m.key)}${idx === 'ip' ? ' <span class="tooltip-tag">in progress</span>' : ''}</div>
        <div class="chart-tooltip-row"><span class="swatch curr"></span> <strong>${fmtCompact(m.curr.longViews || 0)}</strong> views</div>
        <div class="chart-tooltip-row"><span class="swatch likes"></span> <strong>${rate.toFixed(2)}%</strong> like rate</div>
      `;
      const desired = bbox.left - wrap.left + bbox.width / 2;
      const tipWidth = tooltip.offsetWidth || 200;
      const margin = 8;
      const half = tipWidth / 2;
      const minLeft = half + margin;
      const maxLeft = wrap.width - half - margin;
      const clamped = Math.max(minLeft, Math.min(maxLeft, desired));
      tooltip.style.left = clamped + 'px';
      tooltip.style.top = (bbox.top - wrap.top - 8) + 'px';
    });
    rect.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  });
}

// Engagement variance chart — bar chart of "% of each month's videos that
// beat the channel's p90 like-rate baseline". The story we want to surface:
// a sudden, out-of-trend upswing in high-engagement videos. In steady-state,
// roughly 10% of videos should sit above p90 by definition. A month where
// 40-50% of videos cross that threshold is a striking signal the audience
// profile has shifted (or the channel is uploading content that resonates
// disproportionately with a smaller, more passionate base).
//
// Why p90 specifically: it's the threshold the per-video badges already use,
// so this chart and the badges in the video lists tell the same story at
// different grains. Consistency matters editorially.
//
// Filters mirror the baseline computation — videos under 1k views, under 3
// days old, or with no likes are excluded. Edge cases:
// - Months with qualifying videos but none above p90 (genuinely measured
//   "uneventful" months) render with a minimum-height visible bar at the
//   baseline, NOT skipped — they're legitimate zero-pct data points.
// - Months with no qualifying videos at all render as a small dim tick at
//   the baseline so the user can distinguish "no measurable data" from
//   "measured but quiet".
function renderEngagementVarianceChart(chartData, inProgressMonth) {
  const svg = document.getElementById('trendChart');
  const legend = document.getElementById('trendLegend');
  const tooltip = document.getElementById('chartTooltip');
  if (tooltip) tooltip.style.display = 'none';

  const W = 720, H = 280;
  const P = { top: 20, right: 24, bottom: 48, left: 56 };
  const innerW = W - P.left - P.right;
  const innerH = H - P.top - P.bottom;
  // n/nTotal derived after monthData is built (we need monthData first so
  // computeMonth can read p90/now/minAgeMs which depend on the baseline check).

  // Get the channel's p90 baseline. If no baseline (channel has too few
  // historical samples), the chart can't function — render empty state.
  const baseline = selectedChannel !== 'ALL'
    ? likeRateBaselines.get(selectedChannel)
    : null;
  if (!baseline) {
    svg.innerHTML = '';
    legend.innerHTML = '<span class="trend-legend-item" style="color: var(--text-dim);">Not enough historical data on this channel to compute baselines.</span>';
    return;
  }
  const p90 = baseline.p90;
  const now = Date.now();
  const minAgeMs = 3 * 86400 * 1000;

  // Build the legend with explicit, plain-English framing. We're counting
  // top-tier-engagement videos (above the channel's all-time p90 — the top
  // 10% threshold of historical like rates). The popover explains what
  // p90 means and why 10% is the natural reference. The chart's editorial
  // job: surface months where many MORE than usual videos are top-tier.
  const p90Pct = (p90 * 100).toFixed(1);
  const popoverText = `What "top-tier engagement" means: a like rate above ${p90Pct}% (the channel's all-time top-10% threshold). Normally about 10% of a month's videos clear this bar, since it's defined that way across the channel's full history. Months where 30-60% of videos clear it are a clear engagement upswing.`;
  legend.innerHTML = `
    <span class="trend-legend-item">
      <span class="trend-legend-swatch likerate" style="height: 10px;"></span>
      % of month's videos with top-tier engagement
      <span class="hero-stat-info" style="margin-left: 0.2rem;" tabindex="0" role="button"
            aria-label="About top-tier engagement"
            data-popover="${escapeHtml(popoverText)}">ⓘ</span>
    </span>
  `;

  // Compute per-month {qualifying count, above-p90 count, pct}
  function computeMonth(m) {
    let qualifying = 0, above = 0;
    for (const v of m.curr.longForm) {
      if ((v.views || 0) < 1000) continue;
      if ((v.likes || 0) <= 0) continue;
      const ageMs = now - new Date(v.publishedAt).getTime();
      if (ageMs < minAgeMs) continue;
      qualifying++;
      const rate = v.likes / v.views;
      if (rate >= p90) above++;
    }
    return { qualifying, above, pct: qualifying > 0 ? (above / qualifying) * 100 : null };
  }
  const monthData = chartData.map(m => ({ key: m.key, ...computeMonth(m) }));
  const ipMonthData = inProgressMonth ? { key: inProgressMonth.key, ...computeMonth(inProgressMonth) } : null;
  const n = monthData.length;
  const nTotal = n + (ipMonthData ? 1 : 0);

  // Find Y max. Round up to next 10%. Cap at 100%.
  const allPcts = [...monthData.map(d => d.pct), ipMonthData?.pct].filter(v => v != null);
  if (allPcts.length === 0) {
    svg.innerHTML = '';
    legend.innerHTML = '<span class="trend-legend-item" style="color: var(--text-dim);">No qualifying videos in the selected window.</span>';
    return;
  }
  const rawMax = Math.max(20, ...allPcts);
  const yMax = Math.min(100, Math.ceil(rawMax / 10) * 10);

  const barSlot = innerW / Math.max(1, nTotal);
  const barWidth = Math.max(3, Math.min(28, barSlot * 0.7));
  const xFor = (i) => P.left + barSlot * i + barSlot / 2;
  const yFor = (v) => P.top + innerH - (v / yMax) * innerH;

  // Y grid + labels — 10% increments up to yMax
  let gridLines = '', yLabels = '';
  for (let v = 0; v <= yMax; v += 10) {
    const y = yFor(v);
    gridLines += `<line class="chart-grid-line" x1="${P.left}" y1="${y}" x2="${W - P.right}" y2="${y}" />`;
    yLabels += `<text class="chart-axis-label y" x="${P.left - 8}" y="${y + 4}" text-anchor="end">${v}%</text>`;
  }

  // Reference line at 10% — the "expected" rate by definition (p90 means 10%
  // of all-time videos cross the threshold). Visual reminder of the baseline
  // — bars rising clearly above this line are the editorial story.
  //
  // Styling: stronger than a gridline (chart-bar-ref-line) and the label sits
  // on a small backdrop so it's readable when bars are behind it.
  const refY = yFor(10);
  // Label positioned on the left to avoid the right-side year/X-axis labels
  // and any bars that grow tall enough to overlap the right edge. The white
  // backdrop rect keeps the text legible regardless of what's behind.
  const refLabelX = P.left + 6;
  const refLabelY = refY - 5;
  // Approximate text width for the backdrop — rendered via a paint-order
  // technique so we don't need to measure DOM. ~85px covers "expected: 10%".
  const refLine = `
    <line class="chart-bar-ref-line" x1="${P.left}" y1="${refY}" x2="${W - P.right}" y2="${refY}" />
    <text class="chart-bar-ref-label" x="${refLabelX}" y="${refLabelY}" text-anchor="start"
          style="paint-order: stroke; stroke: var(--surface-2); stroke-width: 4px; stroke-linejoin: round;">expected: 10%</text>
  `;

  // X axis labels — same three-strategy logic as the other charts
  const years = new Set(chartData.map(m => m.key.slice(0, 4)));
  const spansMultipleYears = years.size > 1;
  let xLabels = '';
  function monthShort(key) {
    const [, mo] = key.split('-').map(Number);
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mo - 1];
  }
  if (spansMultipleYears && n > 24) {
    const yearFirstIdx = new Map();
    chartData.forEach((m, i) => {
      const y = m.key.slice(0, 4);
      if (!yearFirstIdx.has(y)) yearFirstIdx.set(y, i);
    });
    for (const [year, i] of yearFirstIdx.entries()) {
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${year}</text>`;
    }
  } else if (spansMultipleYears) {
    const labelStride = n <= 13 ? 1 : Math.max(1, Math.ceil(n / 6));
    const yearsSeen = new Set();
    for (let i = 0; i < n; i++) {
      if (i % labelStride !== 0 && i !== n - 1) continue;
      const year = chartData[i].key.slice(0, 4);
      const mon = monthShort(chartData[i].key);
      const showYear = !yearsSeen.has(year);
      yearsSeen.add(year);
      const text = showYear ? `${mon} '${year.slice(2)}` : mon;
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${text}</text>`;
    }
  } else {
    const labelStride = n <= 13 ? 1 : Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i++) {
      if (i % labelStride !== 0 && i !== n - 1) continue;
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${monthShort(chartData[i].key)}</text>`;
    }
  }

  // Bars + hit areas. Bars are coloured by whether they clear the expected
  // line — above 10% = vivid purple, at-or-below = muted, so the upswing
  // months pop visually.
  //
  // Two edge cases:
  // - pct == null: the month had ZERO qualifying videos (no like data at all,
  //   or all videos filtered out by recency/views thresholds). Renders as a
  //   small dim tick at the baseline so users can see "checked but nothing
  //   to measure".
  // - pct == 0: the month had qualifying videos, but none cleared the p90
  //   threshold. This is legitimately measured data and shouldn't be invisible
  //   — we give it a minimum bar height so the user can see "yes, this month
  //   was uneventful for top-tier engagement" rather than reading it as no data.
  //   — we give it a minimum bar height so the user can see "yes, this month
  //   was uneventful for top-tier engagement" rather than reading it as no data.
  let bars = '', hovers = '', noDataMarks = '';
  const baseY = P.top + innerH;
  const MIN_VISIBLE_HEIGHT = 2;  // pixels — enough to be visible without dominating
  for (let i = 0; i < n; i++) {
    const d = monthData[i];
    const x = xFor(i);
    if (d.pct == null) {
      // Small grey tick — "no data measured this month"
      noDataMarks += `<line class="chart-bar-nodata" x1="${x}" y1="${baseY - 2}" x2="${x}" y2="${baseY + 2}" />`;
      continue;
    }
    // Compute height; ensure zero-pct months still produce a visible mark
    const yTop = yFor(d.pct);
    const rawHeight = baseY - yTop;
    const height = Math.max(rawHeight, MIN_VISIBLE_HEIGHT);
    const yFinal = baseY - height;
    const cls = d.pct >= 10 ? 'chart-bar-variance high' : 'chart-bar-variance low';
    bars += `<rect class="${cls}" x="${x - barWidth / 2}" y="${yFinal}" width="${barWidth}" height="${height}" />`;
    hovers += `<rect class="chart-hit" x="${x - barSlot / 2}" y="${P.top}" width="${barSlot}" height="${innerH}" data-idx="${i}" />`;
  }
  // In-progress month bar — dashed outline / lower opacity to signal not-complete
  let ipBar = '';
  if (ipMonthData && ipMonthData.pct != null) {
    const x = xFor(n);
    const yTop = yFor(ipMonthData.pct);
    const height = (P.top + innerH) - yTop;
    const cls = ipMonthData.pct >= 10 ? 'chart-bar-variance high in-progress' : 'chart-bar-variance low in-progress';
    ipBar = `<rect class="${cls}" x="${x - barWidth / 2}" y="${yTop}" width="${barWidth}" height="${height}" />`;
    hovers += `<rect class="chart-hit" x="${x - barSlot / 2}" y="${P.top}" width="${barSlot}" height="${innerH}" data-idx="ip" />`;
  }

  // Site attribution
  const channelName = activeDisplayName();
  const startEl = document.getElementById('startDate');
  const endEl = document.getElementById('endDate');
  const dateRange = startEl && endEl ? `${startEl.value} – ${endEl.value}` : '';
  const isNarrow = window.matchMedia('(max-width: 540px)').matches;
  const attributionText = isNarrow
    ? `${channelName} · jerminaldecline.com`
    : `${channelName} · ${dateRange} · jerminaldecline.com`;
  const attribution = `
    <text class="chart-attribution" x="${P.left + innerW}" y="${H - 8}" text-anchor="end">
      ${escapeHtml(attributionText)}
    </text>
  `;

  svg.innerHTML = `
    ${gridLines}
    ${noDataMarks}
    ${bars}
    ${ipBar}
    ${refLine}
    ${xLabels}
    ${yLabels}
    ${attribution}
    ${hovers}
  `;

  // Tooltip
  const wrapEl = document.getElementById('chartWrap');
  svg.querySelectorAll('.chart-hit').forEach(rect => {
    rect.addEventListener('mouseenter', () => {
      const idx = rect.getAttribute('data-idx');
      const d = idx === 'ip' ? ipMonthData : monthData[Number(idx)];
      if (!d || d.pct == null) return;
      const bbox = rect.getBoundingClientRect();
      const wrap = wrapEl.getBoundingClientRect();
      tooltip.style.display = 'block';
      tooltip.innerHTML = `
        <div class="tooltip-month">${monthLabel(d.key)}${idx === 'ip' ? ' <span class="tooltip-tag">in progress</span>' : ''}</div>
        <div class="chart-tooltip-row"><strong>${d.above} of ${d.qualifying}</strong> videos with top-tier engagement</div>
        <div class="chart-tooltip-row"><strong>${d.pct.toFixed(0)}%</strong> of the month's videos</div>
      `;
      const desired = bbox.left - wrap.left + bbox.width / 2;
      const tipWidth = tooltip.offsetWidth || 200;
      const margin = 8;
      const half = tipWidth / 2;
      const minLeft = half + margin;
      const maxLeft = wrap.width - half - margin;
      const clamped = Math.max(minLeft, Math.min(maxLeft, desired));
      tooltip.style.left = clamped + 'px';
      tooltip.style.top = (bbox.top - wrap.top - 8) + 'px';
    });
    rect.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  });
}

// Scatter chart of individual video durations over time. Used in the "All
// videos" chart mode — each dot is one video, plotted by (publish date, duration).
// Together with the duration overlay on the views chart, this gives the user
// two views of the same underlying data: the median line shows the central
// tendency over time, while the scatter shows the spread of individual videos
// the median is summarising. The eye reads the cloud as a "band of typical durations"
// that shifts over time, with the recent spike visible as the band stepping upward.
function renderAllVideosChart(chartData, inProgressMonth) {
  const svg = document.getElementById('trendChart');
  const legend = document.getElementById('trendLegend');
  const tooltip = document.getElementById('chartTooltip');
  tooltip.style.display = 'none';

  // Legend
  legend.innerHTML = '<span class="trend-legend-item"><span class="trend-legend-swatch scatter"></span> Each dot is one long-form video</span>';

  // Combine complete months + in-progress month to plot the whole timeline
  const allBuckets = [...chartData];
  if (inProgressMonth) allBuckets.push(inProgressMonth);

  // Collect all video durations to compute Y axis bounds.
  // Outliers are common (90+ minute livestreams), so we clip the Y range to
  // a percentile rather than using true min/max — keeps the chart focused on
  // the bulk of the distribution where the story lives. Without clipping a single
  // 2-hour stream would compress the typical band into a thin line at the bottom.
  const allDurations = [];
  for (const m of allBuckets) {
    for (const v of (m.curr.longForm || [])) {
      if (v.durationSec > 0) allDurations.push(v.durationSec);
    }
  }
  if (!allDurations.length) {
    svg.innerHTML = '';
    return;
  }
  allDurations.sort((a, b) => a - b);
  // Use 1st and 99th percentiles to define the visible range. Most channels'
  // typical content falls well within this, while extreme outliers (livestreams)
  // are excluded from rendering. We then ensure the upper bound reaches at
  // least 23:30 (1410s) — long enough to capture the recent ramp-up in video
  // duration where some uploads now exceed 20 minutes. Without this floor, the
  // axis would compress around the median band and crop the interesting tail.
  const pct = (arr, p) => arr[Math.floor(arr.length * p)];
  const rawMin = pct(allDurations, 0.01);
  const rawMaxPct = pct(allDurations, 0.99);
  // Floor the visible upper bound at 23:30 = 1410 seconds. This is a deliberate
  // editorial choice: the duration spike is the story, longer videos must be visible.
  const MIN_VISIBLE_MAX = 1410;
  const rawMax = Math.max(rawMaxPct, MIN_VISIBLE_MAX);
  const axis = niceDurationAxis(rawMin, rawMax);
  const durMin = axis.min;
  const durMax = axis.max;

  // Layout
  // Note: P.left increased to accommodate the rotated "Video duration" axis label
  // sitting outside the tick numbers without overlapping them.
  const W = 720, H = 280;
  const P = { top: 20, right: 24, bottom: 48, left: 80 };
  const innerW = W - P.left - P.right;
  const innerH = H - P.top - P.bottom;

  const n = allBuckets.length;
  // Slot model: each month occupies an equal-width slot of innerW/n. xFor(i)
  // returns the LEFT edge of slot i; the last slot's right edge lands exactly
  // at P.left+innerW. This gives every month — including the final in-progress
  // one — a full slot for its day-of-month dot spread, so late-month videos
  // never overflow the right axis. xCenter(i) is used for axis tick labels so
  // they sit under the middle of each month's dot cluster.
  const slotW = innerW / n;
  const xFor = i => P.left + i * slotW;
  const xCenter = i => P.left + (i + 0.5) * slotW;
  const yForDur = v => P.top + (1 - (v - durMin) / (durMax - durMin)) * innerH;

  // Grid lines & Y axis ticks (left axis — duration is the only axis now)
  const yTicks = [];
  for (let v = durMin; v <= durMax; v += axis.step) {
    yTicks.push({ y: yForDur(v), v });
  }
  const gridLines = yTicks.map(t =>
    `<line class="chart-grid" x1="${P.left}" y1="${t.y}" x2="${P.left + innerW}" y2="${t.y}"/>`
  ).join('');
  const yLabels = yTicks.map(t =>
    `<text class="chart-axis-label y" x="${P.left - 8}" y="${t.y + 4}">${fmtDurStat(t.v)}</text>`
  ).join('');

  // X-axis labels — density adapts to how many months are in view.
  // The rule: aim for 6-12 labels visible at any zoom level. Too few looks bare;
  // too many turns to a smear. The 1.5-year / 3.5-year breakpoints below were
  // calibrated for this density target on a ~720px-wide chart.
  const monthCount = allBuckets.length;
  const quarterTicks = [];
  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Decide cadence: which months get labels based on how many are visible.
  // The principle is calendar-aligned: same months labelled regardless of where
  // the data starts. Year-on-Jan keeps year transitions visible at every density.
  //
  //   ≤13 months → every month
  //   14-30      → every quarter (Jan, Apr, Jul, Oct)
  //   31-60      → Jan and Jul of each year (2 per year)
  //   60+        → Jan only
  let isLabelMonth, getTickHeight;
  if (monthCount <= 13) {
    isLabelMonth = () => true;
    getTickHeight = (month) => (month === 1) ? 5 : 3;
  } else if (monthCount <= 30) {
    isLabelMonth = (month) => (month === 1 || month === 4 || month === 7 || month === 10);
    getTickHeight = (month) => (month === 1) ? 5 : (month === 4 || month === 7 || month === 10) ? 3 : 0;
  } else if (monthCount <= 60) {
    isLabelMonth = (month) => (month === 1 || month === 7);
    getTickHeight = (month) => (month === 1) ? 6 : (month === 4 || month === 7 || month === 10) ? 3 : 0;
  } else {
    isLabelMonth = (month) => (month === 1);
    getTickHeight = (month) => (month === 1) ? 6 : (month === 4 || month === 7 || month === 10) ? 3 : 0;
  }

  // First pass: build all candidate labels with x positions.
  // We always label the first data point so the chart has an unambiguous start —
  // but mark it so we can suppress/shorten it later if it would collide with
  // the next regular cadence label.
  const candidates = [];  // {x, text, isFirst, month, year}
  allBuckets.forEach((m, i) => {
    const month = parseInt(m.key.slice(5, 7));
    const year = m.key.slice(0, 4);

    // Always emit a tick at the right cadence
    const tickH = getTickHeight(month);
    if (tickH > 0) {
      quarterTicks.push(
        `<line class="chart-axis-tick" x1="${xCenter(i)}" y1="${P.top + innerH}" x2="${xCenter(i)}" y2="${P.top + innerH + tickH}"/>`
      );
    }

    // Emit a candidate label if either (a) this is the first index (so the
    // chart's left edge is anchored to a known date), or (b) this month is
    // part of the chosen cadence.
    const monthName = MONTH_NAMES[month - 1];
    if (i === 0) {
      candidates.push({
        x: xCenter(i),
        text: `${monthName} ${year}`,
        isFirst: true,
        month, year, index: i
      });
    } else if (isLabelMonth(month)) {
      // Cadence label. Show "Jan 2026" on January (year marker), or just the
      // month name otherwise.
      const text = (month === 1) ? `${monthName} ${year}` : monthName;
      candidates.push({
        x: xCenter(i),
        text,
        isFirst: false,
        month, year, index: i
      });
    }
  });

  // Second pass: de-conflict labels that are too close together.
  // The most common collision is between the always-labelled first index and
  // the first regular cadence label that follows shortly after.
  // We use the approximate label width (chars × 7px) to detect overlap, and
  // drop the LATER label if both are near each other, since the first-index
  // label is more important (anchors the chart's left edge to a date).
  const MIN_LABEL_GAP = 50;  // pixels between label centres
  const xLabels = [];
  let lastCentre = -Infinity;
  candidates.forEach((c, idx) => {
    if (c.x - lastCentre < MIN_LABEL_GAP) {
      // Collision: prefer keeping the FIRST candidate when one is the chart's
      // anchor (isFirst), since that's the user's "where am I" reference.
      // Otherwise prefer the candidate that carries a year (more information).
      const prev = xLabels[xLabels.length - 1];
      if (prev && !prev._isFirst && c.text.includes(' ')) {
        // Current carries year, previous doesn't → replace previous
        xLabels.pop();
        xLabels.push({ html: `<text class="chart-axis-label x" x="${c.x}" y="${H - 26}">${c.text}</text>`, _isFirst: c.isFirst });
        lastCentre = c.x;
      }
      // Otherwise skip this label entirely (keep what we already have)
    } else {
      xLabels.push({ html: `<text class="chart-axis-label x" x="${c.x}" y="${H - 26}">${c.text}</text>`, _isFirst: c.isFirst });
      lastCentre = c.x;
    }
  });
  // Convert label objects back to string array for the SVG joiner downstream
  const xLabelsHtml = xLabels.map(l => l.html);

  // Build scatter dots — one per video, day-of-month interpolated for X.
  // Outliers clipped to the visible Y range, dropped if outside.
  let outliersAbove = 0;
  let outliersBelow = 0;
  const dotsHtml = [];
  for (let i = 0; i < allBuckets.length; i++) {
    const monthEntry = allBuckets[i];
    const monthVids = monthEntry.curr.longForm || [];
    if (!monthVids.length) continue;
    const [yStr, mStr] = monthEntry.key.split('-');
    const year = parseInt(yStr);
    const monthNum = parseInt(mStr);
    const daysInMonth = new Date(year, monthNum, 0).getDate();
    // Each month fills its own slot [xFor(i), xFor(i)+slotW]. This holds for
    // every bucket including the last, so day-of-month spread stays inside the
    // plot with no special-casing or overflow.
    const xStart = xFor(i);
    const xEnd = xStart + slotW;
    for (const v of monthVids) {
      if (!v.durationSec || v.durationSec <= 0) continue;
      if (v.durationSec > durMax) { outliersAbove++; continue; }
      if (v.durationSec < durMin) { outliersBelow++; continue; }
      const dayOfMonth = parseInt(v.publishedAt.slice(8, 10));
      const dayFrac = Math.max(0, Math.min(1, (dayOfMonth - 1) / daysInMonth));
      const x = xStart + dayFrac * (xEnd - xStart);
      const y = yForDur(v.durationSec);
      dotsHtml.push(`<circle class="chart-scatter-dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.8"/>`);
    }
  }
  const scatterDots = dotsHtml.join('');

  // Outlier caption — small note inside the top-left of the plot area
  // (not below the chart, where overflow:visible on the SVG could let it
  // escape the chart panel's visible bounds).
  let outlierCaption = '';
  if (outliersAbove + outliersBelow > 0) {
    const parts = [];
    if (outliersAbove > 0) parts.push(`${outliersAbove} above ${fmtDurStat(durMax)}`);
    if (outliersBelow > 0) parts.push(`${outliersBelow} below ${fmtDurStat(durMin)}`);
    outlierCaption = `<text class="chart-attribution" x="${P.left + 6}" y="${P.top + 12}" style="text-anchor: start;">${parts.join(', ')} outside view</text>`;
  }

  // Brand attribution — bottom-right corner. Matches the main trend chart so
  // anyone screenshotting either visualisation gets the channel name + site URL
  // baked in. Date range is included to ground the data in time.
  const channelName = activeDisplayName();
  const startEl = document.getElementById('startDate');
  const endEl = document.getElementById('endDate');
  const dateRange = startEl && endEl ? `${startEl.value} – ${endEl.value}` : '';
  const isNarrow = window.matchMedia('(max-width: 540px)').matches;
  const attributionText = isNarrow
    ? `${channelName} · jerminaldecline.com`
    : `${channelName} · ${dateRange} · jerminaldecline.com`;
  const attribution = `
    <text class="chart-attribution" x="${P.left + innerW}" y="${H - 8}" text-anchor="end">
      ${escapeHtml(attributionText)}
    </text>
  `;

  // Y-axis title — "Video duration" rotated 90° along the left edge of the plot.
  // Sits to the left of the tick value labels (e.g. "10:00", "12:00"). The
  // rotation point and translation are chosen so the text reads bottom-to-top
  // and is centred vertically with the plot area.
  const yAxisTitleX = 16;  // px from left edge of viewBox
  const yAxisTitleY = P.top + innerH / 2;
  const yAxisTitle = `<text class="chart-axis-title" x="${yAxisTitleX}" y="${yAxisTitleY}" transform="rotate(-90 ${yAxisTitleX} ${yAxisTitleY})" style="text-anchor: middle;">Video duration</text>`;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <line class="chart-axis-line" x1="${P.left}" y1="${P.top + innerH}" x2="${P.left + innerW}" y2="${P.top + innerH}"/>
    ${quarterTicks.join('')}
    ${gridLines}
    ${yLabels}
    ${xLabelsHtml.join('')}
    ${yAxisTitle}
    ${scatterDots}
    ${outlierCaption}
    ${attribution}
  `;
}

// Estimated revenue trend chart — same line-chart pattern as the views chart,
// but with a shaded band between the low and high revenue estimates and a
// mid-line through the middle. The band makes the uncertainty in the estimate
// visually honest: you see the range, not a deceptively precise single line.
//
// No YoY comparison here. RPM ranges shift year-to-year (the published
// industry data only covers 2025-2026), so comparing a 2018 monthly estimate
// against a 2019 monthly estimate using today's RPM ranges would mostly be
// showing how views differ, not how revenue actually differed at the time.
// Cleaner to just show one line.
// Estimated revenue trend chart. Two render targets exist:
//   1. The main #trendChart SVG (when called from renderTrendChart's
//      revenue-mode branch — legacy path, no longer reachable from the UI
//      since we removed the chart-toggle button, but kept for safety).
//   2. The dedicated #revenueChart SVG inside the revenue panel body.
//
// Options bag lets the caller pick which SVG to draw into and whether to
// suppress the shared chart tooltip (the panel chart uses a smaller inline
// tooltip styled to match the panel's tighter layout).
function renderRevenueChart(chartData, inProgressMonth, options = {}) {
  const svgId = options.svgId || 'trendChart';
  const legendId = options.legendId || 'trendLegend';
  const svg = document.getElementById(svgId);
  if (!svg) return;
  const legend = legendId ? document.getElementById(legendId) : null;
  const tooltip = document.getElementById('chartTooltip');
  if (tooltip) tooltip.style.display = 'none';

  // Scenario accessors — the chart plots whichever scenario is active in
  // the panel. Pessimistic uses revPess* fields, optimistic uses rev*.
  const usePess = revenueScenario === 'pessimistic';
  const rLow = m => (usePess ? m.curr.revPessLow : m.curr.revLow) || 0;
  const rHigh = m => (usePess ? m.curr.revPessHigh : m.curr.revHigh) || 0;
  const rMid = m => (usePess ? m.curr.revPessMid : m.curr.revMid) || 0;

  // Hide the chart entirely for a single completed month (with or without an
  // in-progress month) — a line/band with only one data point is meaningless
  // and looks broken. The headline summary above and the breakdown table
  // below already cover this case adequately.
  // The caller (panel render) is responsible for hiding the chart wrap; we
  // just clear the SVG so nothing stale lingers if the data shrinks.
  if (chartData.length < 2) {
    svg.innerHTML = '';
    if (legend) legend.innerHTML = '';
    const wrap = options.wrapEl || document.getElementById('chartWrap');
    if (wrap && options.wrapEl) {
      // Only hide the panel chart wrap, not the main chart wrap (which has
      // other render modes that don't need to hide on single-month).
      wrap.style.display = 'none';
    }
    return;
  }
  // Otherwise make sure the wrap is visible (in case a previous render hid it)
  if (options.wrapEl) options.wrapEl.style.display = '';

  if (legend) {
    legend.innerHTML = `
      <span class="trend-legend-item"><span class="trend-legend-swatch revenue-mid"></span> Mid-range estimate</span>
      <span class="trend-legend-item"><span class="trend-legend-swatch revenue-band"></span> Low–high range</span>
    `;
  }

  // Layout — same dimensions as the views chart for visual consistency.
  const W = 720, H = 280;
  const P = { top: 20, right: 24, bottom: 48, left: 66 };
  const innerW = W - P.left - P.right;
  const innerH = H - P.top - P.bottom;

  // Combine completed + in-progress months
  const allBuckets = [...chartData];
  if (inProgressMonth) allBuckets.push(inProgressMonth);

  // Y axis: based on the HIGH estimate (top of the band), so the band
  // always fits inside the chart. We want minimal headroom above the band
  // — the visual impact of the decline depends on the peak band filling
  // most of the chart height. Use a tighter "nice" rounding (more factor
  // granularity than niceMax) and skip the 5% padding the views chart adds.
  const highValues = allBuckets.map(m => rHigh(m));
  const rawMax = Math.max(1, ...highValues);
  const axis = tightNiceAxis(rawMax);
  const yMax = axis.max;
  const yStep = axis.step;

  // X positions — match the trend chart's logic of extending the scale by
  // one slot for the in-progress month so it sits visually outside the trend
  // proper but inside the chart bounds.
  const n = chartData.length;
  const nTotal = n + (inProgressMonth ? 1 : 0);
  function xFor(i) {
    if (nTotal === 1) return P.left + innerW / 2;
    return P.left + (i / (nTotal - 1)) * innerW;
  }
  function yFor(value) {
    return P.top + innerH - (value / yMax) * innerH;
  }

  // Format USD for axis labels — uses compact form so $25,000 renders as $25k
  function fmtAxisUSD(amount) {
    if (amount >= 1e6) return '$' + (amount / 1e6).toFixed(amount >= 1e7 ? 0 : 1) + 'M';
    if (amount >= 1000) return '$' + (amount / 1000).toFixed(amount >= 10000 ? 0 : 1) + 'k';
    return '$' + Math.round(amount);
  }

  // Y axis grid + labels — driven by the step returned from tightNiceAxis
  // so labels land on clean values. Defensive cap at 10 ticks in case step
  // is small relative to max (shouldn't happen, but guards against bad data).
  let gridLines = '', yLabels = '';
  const tickCount = Math.min(10, Math.round(yMax / yStep));
  for (let i = 0; i <= tickCount; i++) {
    const v = yStep * i;
    if (v > yMax + 0.001) break;
    const y = yFor(v);
    gridLines += `<line class="chart-grid-line" x1="${P.left}" y1="${y}" x2="${W - P.right}" y2="${y}" />`;
    yLabels += `<text class="chart-axis-label y" x="${P.left - 8}" y="${y + 4}" text-anchor="end">${fmtAxisUSD(v)}</text>`;
  }

  // X axis labels — three strategies by range size, mirroring the views chart
  // (where this approach has been battle-tested):
  //   1. Long range (25+ months, spans years) → one label per year, anchored to
  //      January of that year (or chart start if first year is mid-range).
  //   2. Medium range (13-24 months spanning years) → strided labels with
  //      year suffix shown on the first appearance of each new year.
  //   3. Short range (≤12 months OR single year) → strided month abbreviations.
  // labelStride is computed so we never produce more than ~6 labels for the
  // strided cases, regardless of n. Empty labels are skipped — saves SVG nodes.
  const years = new Set(chartData.map(m => m.key.slice(0, 4)));
  const spansMultipleYears = years.size > 1;
  let xLabels = '';
  function monthShort(key) {
    const [y, mo] = key.split('-').map(Number);
    return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][mo - 1];
  }
  if (spansMultipleYears && n > 24) {
    // Long range: just years, at the first month of each year (or chart start)
    const yearFirstIdx = new Map();
    chartData.forEach((m, i) => {
      const y = m.key.slice(0, 4);
      if (!yearFirstIdx.has(y)) yearFirstIdx.set(y, i);
    });
    for (const [year, i] of yearFirstIdx.entries()) {
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${year}</text>`;
    }
  } else if (spansMultipleYears) {
    // Medium range: stride month labels, append abbreviated year on first hit
    const labelStride = n <= 13 ? 1 : Math.max(1, Math.ceil(n / 6));
    const yearsSeen = new Set();
    for (let i = 0; i < n; i++) {
      if (i % labelStride !== 0 && i !== n - 1) continue;
      const year = chartData[i].key.slice(0, 4);
      const mon = monthShort(chartData[i].key);
      const showYear = !yearsSeen.has(year);
      yearsSeen.add(year);
      const text = showYear ? `${mon} '${year.slice(2)}` : mon;
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${text}</text>`;
    }
  } else {
    // Single year: month abbreviations on a stride
    const labelStride = n <= 13 ? 1 : Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i++) {
      if (i % labelStride !== 0 && i !== n - 1) continue;
      xLabels += `<text class="chart-axis-label x" x="${xFor(i)}" y="${H - 26}" text-anchor="middle">${monthShort(chartData[i].key)}</text>`;
    }
  }

  // Band path — fill between low and high lines
  let bandTop = '', bandBottom = '';
  for (let i = 0; i < n; i++) {
    const x = xFor(i);
    const yHigh = yFor(rHigh(chartData[i]));
    const yLow = yFor(rLow(chartData[i]));
    bandTop += `${i === 0 ? 'M' : 'L'}${x},${yHigh}`;
    bandBottom = `L${x},${yLow}` + bandBottom;
  }
  const bandPath = bandTop + bandBottom + 'Z';

  // Mid line
  let midPath = '';
  for (let i = 0; i < n; i++) {
    const x = xFor(i);
    const y = yFor(rMid(chartData[i]));
    midPath += `${i === 0 ? 'M' : 'L'}${x},${y}`;
  }

  // Hover targets — invisible wide rects that capture mouse and trigger tooltips
  let hovers = '';
  for (let i = 0; i < n; i++) {
    const x = xFor(i);
    const wHover = innerW / Math.max(1, nTotal - 1);
    hovers += `<rect class="chart-hit" x="${x - wHover / 2}" y="${P.top}" width="${wHover}" height="${innerH}" data-idx="${i}" />`;
  }

  // In-progress month dot (if applicable) — plus a dashed connector from
  // the last complete month's mid-value so the dot doesn't float disconnected
  // from the line. Mirrors the views chart's in-progress treatment.
  let ipDot = '';
  let ipConnector = '';
  if (inProgressMonth) {
    const x = xFor(n);
    const y = yFor(rMid(inProgressMonth));
    // Connect from the last completed month's mid-point
    const lastIdx = n - 1;
    const lastX = xFor(lastIdx);
    const lastY = yFor(rMid(chartData[lastIdx]));
    ipConnector = `<path class="chart-line-revenue-inprogress" d="M ${lastX} ${lastY} L ${x} ${y}" />`;
    ipDot = `<circle class="chart-dot-inprogress-pulse" cx="${x}" cy="${y}" r="4" /><circle class="chart-dot-inprogress" cx="${x}" cy="${y}" r="4" />`;
    const wHover = innerW / Math.max(1, nTotal - 1);
    hovers += `<rect class="chart-hit" x="${x - wHover / 2}" y="${P.top}" width="${wHover}" height="${innerH}" data-idx="ip" />`;
  }

  svg.innerHTML = `
    ${gridLines}
    <path class="chart-revenue-band" d="${bandPath}" />
    <path class="chart-line-revenue" d="${midPath}" />
    ${ipConnector}
    ${ipDot}
    ${xLabels}
    ${yLabels}
    ${hovers}
  `;

  // Tooltip wiring — positioned relative to the SVG's containing wrap.
  // For the main chart that's #chartWrap; for the panel chart it's the
  // panel-supplied wrap element. We use a tooltip element specific to the
  // chart's container to avoid the main chart's tooltip floating in unrelated
  // places when the panel chart is hovered.
  const wrapEl = options.wrapEl || document.getElementById('chartWrap');
  const tooltipEl = options.tooltipEl
    ? document.getElementById(options.tooltipEl)
    : tooltip;
  if (!tooltipEl || !wrapEl) {
    // Without a tooltip target there's no interactive layer to wire up.
    return;
  }
  svg.querySelectorAll('.chart-hit').forEach(rect => {
    rect.addEventListener('mouseenter', () => {
      const idx = rect.getAttribute('data-idx');
      const m = idx === 'ip' ? inProgressMonth : chartData[Number(idx)];
      if (!m) return;
      const bbox = rect.getBoundingClientRect();
      const wrap = wrapEl.getBoundingClientRect();
      tooltipEl.style.display = 'block';
      // Set the content first so the tooltip has its real width when we measure
      tooltipEl.innerHTML = `
        <div class="tooltip-month">${monthLabel(m.key)}${idx === 'ip' ? ' <span class="tooltip-tag">in progress</span>' : ''}</div>
        <div class="tooltip-row"><strong>${fmtAxisUSD(rLow(m))} – ${fmtAxisUSD(rHigh(m))}</strong></div>
        <div class="tooltip-row tooltip-detail">${fmt(m.curr.longViews)} long-form + ${fmt(m.curr.shortViews)} Shorts views</div>
      `;
      // Tooltip uses transform: translate(-50%, -100%) — the `left` value is
      // the CENTRE of the tooltip. Clamp it so the tooltip stays inside the
      // wrap horizontally rather than extending beyond an edge and getting
      // clipped (the panel and other ancestors might clip overflow). Vertical
      // clamping doesn't matter as much because tooltips above the chart top
      // remain visible — the wrap doesn't clip vertically.
      const desired = bbox.left - wrap.left + bbox.width / 2;
      const tipWidth = tooltipEl.offsetWidth || 200;  // fallback if not yet measured
      const margin = 8;
      const half = tipWidth / 2;
      const minLeft = half + margin;
      const maxLeft = wrap.width - half - margin;
      const clamped = Math.max(minLeft, Math.min(maxLeft, desired));
      tooltipEl.style.left = clamped + 'px';
      tooltipEl.style.top = (bbox.top - wrap.top - 8) + 'px';
    });
    rect.addEventListener('mouseleave', () => { tooltipEl.style.display = 'none'; });
  });
}

// Pick a "nice" max for Y axis — round up to a clean multiple
function niceMax(v) {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  let factor;
  if (norm <= 1) factor = 1;
  else if (norm <= 1.5) factor = 1.5;
  else if (norm <= 2) factor = 2;
  else if (norm <= 2.5) factor = 2.5;
  else if (norm <= 3) factor = 3;
  else if (norm <= 4) factor = 4;
  else if (norm <= 5) factor = 5;
  else if (norm <= 7.5) factor = 7.5;
  else factor = 10;
  return factor * mag;
}

// Tighter version of niceMax with more factor granularity. Use this when
// you want the peak data to fill more of the chart height — fewer cases
// where the value sits awkwardly far below the rounded axis maximum.
// Worst-case overshoot is ~10% (peak at 0.9× yMax) vs ~33% for niceMax.
// Returns { max, step } so the caller can pick clean tick values.
function tightNiceAxis(v) {
  if (v <= 0) return { max: 1, step: 0.2 };
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const norm = v / mag;
  // Each factor gets a tick step chosen so axis labels land on clean values
  const choices = [
    { factor: 1,   step: 0.2 },
    { factor: 1.2, step: 0.2 },
    { factor: 1.5, step: 0.25 },
    { factor: 1.8, step: 0.3 },
    { factor: 2,   step: 0.5 },
    { factor: 2.5, step: 0.5 },
    { factor: 3,   step: 0.5 },
    { factor: 3.5, step: 0.5 },
    { factor: 4,   step: 1 },
    { factor: 5,   step: 1 },
    { factor: 6,   step: 1 },
    { factor: 7.5, step: 1.5 },
    { factor: 9,   step: 1.5 },
    { factor: 10,  step: 2 }
  ];
  for (const c of choices) {
    if (norm <= c.factor) {
      return { max: c.factor * mag, step: c.step * mag };
    }
  }
  return { max: 10 * mag, step: 2 * mag };
}

// Pick a "nice" tick range for a duration axis: returns { min, max, step } in seconds,
// where min/max are multiples of step, and step is chosen so the axis has 4-8 ticks
// at human-readable intervals (30s, 1m, 2m, 5m, 10m, etc).
// Inputs minSec and maxSec define the observed data range; the returned bounds
// extend outward to clean multiples of the chosen step.
function niceDurationAxis(minSec, maxSec) {
  const span = Math.max(1, maxSec - minSec);
  // Candidate step sizes in seconds, in order of preference
  // (60, 120, 180, 300, 600... and finer at the small end for very tight ranges)
  const candidateSteps = [30, 60, 90, 120, 180, 300, 600, 900, 1800, 3600];
  // Find a step that yields a comfortable 4-8 tick spread
  let step = candidateSteps[0];
  for (const s of candidateSteps) {
    const ticks = Math.ceil(maxSec / s) - Math.floor(minSec / s) + 1;
    if (ticks <= 8) { step = s; break; }
  }
  // Round outward to clean multiples
  const niceMin = Math.max(0, Math.floor(minSec / step) * step);
  const niceMax = Math.ceil(maxSec / step) * step;
  return { min: niceMin, max: niceMax, step };
}
