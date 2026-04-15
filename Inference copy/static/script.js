// KV Cognition Real-Time Inference Cost Engine Demo

const clusters = [
  { name: "RTX4090‑cluster", gpu: "RTX 4090", base: 55, opt: 78.8, rate: 3 },
  { name: "A100‑40GB", gpu: "NVIDIA A100", base: 90, opt: 125.4, rate: 7 },
  { name: "H100‑PCIe", gpu: "NVIDIA H100", base: 120, opt: 165.6, rate: 10 },
  { name: "A6000‑cluster", gpu: "NVIDIA RTX A6000", base: 70, opt: 98.2, rate: 5.6 },
  { name: "T4‑scaled", gpu: "NVIDIA T4", base: 30, opt: 42.1, rate: 1.2 },
  { name: "V100‑DGX", gpu: "NVIDIA V100", base: 85, opt: 118.9, rate: 4.5 },
  { name: "L4‑cluster", gpu: "NVIDIA L4", base: 40, opt: 56.1, rate: 1.5 },
  { name: "MI250X‑cluster", gpu: "AMD MI250X", base: 100, opt: 140.0, rate: 6.5 },
  { name: "H200‑DGX", gpu: "NVIDIA H200", base: 130, opt: 182.0, rate: 12 },
  { name: "A30‑cluster", gpu: "NVIDIA A30", base: 75, opt: 105.0, rate: 3.8 }
];

function getBatchScaling(name) {
  if (name.includes('T4') || name.includes('L4')) return 0.18;
  if (name.includes('A100')) return 0.12;
  if (name.includes('H100') || name.includes('H200')) return 0.10;
  return 0.14; // Default for others
}
const kvScaling = 0.5; // Consistent KV-cache scaling

document.addEventListener('DOMContentLoaded', () => {
  renderCostDemo();
  // What-If slider
  const slider = document.getElementById('whatif-slider');
  if (slider) {
    slider.addEventListener('input', function() {
      document.getElementById('whatif-value').textContent = this.value;
      document.getElementById('similarity').value = this.value;
      showResults();
    });
  }
});

function renderCostDemo() {
  const container = document.getElementById('cost-demo');
  container.innerHTML = `
    <div id="userInputForm" class="user-input-form">
      <label>Monthly Tokens
        <input type="number" id="monthlyTokens" value="10000000" min="1" step="1" autocomplete="off">
      </label>
      <label>Average Input Tokens
        <input type="number" id="avgInputTokens" value="100" min="1" step="1" autocomplete="off">
      </label>
      <label>Average Output Tokens
        <input type="number" id="avgOutputTokens" value="50" min="1" step="1" autocomplete="off">
      </label>
      <label>Traffic Pattern
        <select id="trafficPattern">
          <option value="steady">Steady</option>
          <option value="bursty">Bursty</option>
          <option value="mixed">Mixed</option>
        </select>
      </label>
      <label>Latency Target (sec)
        <input type="number" id="latencyTarget" value="2" min="0.1" step="0.1" autocomplete="off">
      </label>
      <label>Current Budget ($/month)
        <input type="number" id="budget" value="1000" min="1" step="1" autocomplete="off">
      </label>
      <label>Similarity Ratio (0-1, optional)
        <input type="number" id="similarity" value="0.7" min="0" max="1" step="0.01" autocomplete="off">
      </label>
      <button id="calcBtn" type="button" class="run-btn">Calculate Optimization</button>
    </div>
    <div id="optResults"></div>
    <div id="resultsTable"></div>
  `;
  // Attach listeners after DOM update for all relevant fields
  const ids = [
    'monthlyTokens', 'avgInputTokens', 'avgOutputTokens', 'trafficPattern', 'latencyTarget', 'budget', 'similarity'
  ];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', showResults);
      el.addEventListener('change', showResults);
    }
  });
  // Calculate button triggers showResults too
  const calcBtn = document.getElementById('calcBtn');
  if (calcBtn) calcBtn.addEventListener('click', showResults);
  showResults();
}

function showResults() {
  const monthlyTokens = parseInt(document.getElementById('monthlyTokens').value, 10);
  const avgInputTokens = parseInt(document.getElementById('avgInputTokens').value, 10);
  const avgOutputTokens = parseInt(document.getElementById('avgOutputTokens').value, 10);
  const trafficPattern = document.getElementById('trafficPattern').value;
  const latencyTarget = parseFloat(document.getElementById('latencyTarget').value);
  const budget = parseFloat(document.getElementById('budget').value);
  let similarity = parseFloat(document.getElementById('similarity').value);
  if (isNaN(similarity)) similarity = 0.7;


  // Estimate batch size based on traffic pattern
  let batchSize = 8;
  if (trafficPattern === 'steady') batchSize = 16;
  else if (trafficPattern === 'bursty') batchSize = 4;
  else if (trafficPattern === 'mixed') batchSize = 8;

  // Estimate total tokens to process in a month
  const tokens = monthlyTokens;

  // Adjust throughput based on total sequence length (input + output)
  // Assume base throughput is for 150 tokens (100 input + 50 output)
  const baseSeqLen = 150;
  const userSeqLen = avgInputTokens + avgOutputTokens;
  const seqPenalty = userSeqLen / baseSeqLen;

  // Find H100 cluster for savings calculation
  const h100 = clusters.find(c => c.name.includes('H100'));
  let h100Cost = null;

  // Dynamic throughput calculation
  let best = null;
  let minCost = Infinity;
  let fastest = null;
  let minTime = Infinity;
  let bestBalance = null;
  let bestBalanceScore = -Infinity;
  let clusterResults = [];

  clusters.forEach(c => {
    // Dynamic throughput: batch scaling varies by GPU tier, KV-cache scaling consistent
    const batchScaling = getBatchScaling(c.name);
    // Penalize throughput for longer total sequence
    const optThroughput = +(c.base * (1 + batchScaling * (batchSize - 1)) * (1 + kvScaling * similarity) / seqPenalty).toFixed(1);
    const timeNeeded = +(tokens / optThroughput).toFixed(1);
    const optCost = +(timeNeeded * c.rate / 3600).toFixed(2);
    const perToken = +(optCost / tokens).toExponential(2);
    clusterResults.push({
      ...c,
      optThroughput,
      timeNeeded,
      optCost,
      perToken
    });
    if (c === h100) h100Cost = optCost;
    // Only consider clusters that can meet latency target (per request) and budget
    const meetsLatency = (optThroughput >= userSeqLen / latencyTarget);
    const meetsBudget = optCost <= budget;
    if (meetsBudget && meetsLatency && optCost < minCost) {
      best = { ...c, optThroughput, timeNeeded, optCost, perToken };
      minCost = optCost;
    }
    if (timeNeeded < minTime) {
      fastest = { ...c, optThroughput, timeNeeded, optCost, perToken };
      minTime = timeNeeded;
    }
    // Best balance: lowest (cost * time)
    const balanceScore = 1 / (optCost * timeNeeded);
    if (balanceScore > bestBalanceScore) {
      bestBalance = { ...c, optThroughput, timeNeeded, optCost, perToken };
      bestBalanceScore = balanceScore;
    }
  });

  // Dynamic explanation
  const why = [
    `Meets latency constraint (target: ${latencyTarget}s per request, batch size est: ${batchSize})`,
    `Best cost per token under workload`,
    `Traffic pattern: ${trafficPattern}`,
    `High KV-cache reuse efficiency (${similarity} similarity)`
  ];
  document.getElementById('why-explanation').innerHTML = `
    <b>Why this cluster was selected:</b>
    <ul>${why.map(x => `<li>${x}</li>`).join('')}</ul>
  `;

  // Cluster ranking table (dynamic)
  const rankRows = [
    `<tr><th>Rank</th><th>Cluster</th><th>Why</th></tr>`,
    `<tr><td>🥇</td><td>${best.name}</td><td>Cheapest</td></tr>`,
    `<tr><td>⚡</td><td>${fastest.name}</td><td>Fastest</td></tr>`,
    `<tr><td>⚖️</td><td>${bestBalance.name}</td><td>Best balance</td></tr>`
  ].join('');
  document.getElementById('rank-table').innerHTML = rankRows;

  // Main summary
  let savings = h100Cost !== null ? +(h100Cost - best.optCost).toFixed(2) : 'N/A';
  let projectedMonthlySpend = best.optCost;
  document.getElementById('optResults').innerHTML = `
    <div class="opt-summary">
      <h4>Optimization Results</h4>
      <ul>
        <li><b>Best GPU Cluster:</b> ${best.name} (${best.gpu})</li>
        <li><b>Estimated Throughput:</b> ${best.optThroughput} tokens/sec</li>
        <li><b>Time to Process:</b> ${best.timeNeeded.toLocaleString()} sec</li>
        <li><b>Cost per Token:</b> $${best.perToken}</li>
        <li><b>Projected Monthly Spend:</b> $${projectedMonthlySpend}</li>
        <li><b>Estimated Savings vs H100:</b> $${savings}</li>
      </ul>
    </div>
  `;

  // Table (unchanged)
  let rows = clusterResults.map((c, i) => {
    let rowSavings = h100Cost !== null ? +(h100Cost - c.optCost).toFixed(2) : 'N/A';
    return `<tr><td>${i+1}</td><td>${c.name}</td><td>${c.gpu}</td><td>${c.base}</td><td>${c.optThroughput}</td><td>${c.timeNeeded}</td><td>${c.perToken}</td><td>${c.optCost}</td><td>${rowSavings}</td></tr>`;
  }).join('');
  document.getElementById('resultsTable').innerHTML = `
    <table class="results-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Cluster Name</th>
          <th>GPU Type</th>
          <th>Base Throughput<br>(tokens/sec)</th>
          <th>Optimized Throughput<br>(tokens/sec)</th>
          <th>Time Needed<br>(sec)</th>
          <th>Est. Cost per Token ($)</th>
          <th>Optimized Cost ($)</th>
          <th>Est. Savings ($)</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
    <div class="results-summary">
      <b>Summary:</b> Showing all clusters. Optimization based on ${monthlyTokens.toLocaleString()} monthly tokens, traffic pattern: ${trafficPattern}, latency target: ${latencyTarget}s, budget: $${budget}, similarity ratio: ${similarity}.
    </div>
  `;
}
