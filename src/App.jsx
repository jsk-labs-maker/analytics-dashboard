import { useState, useRef, useMemo, useEffect, useCallback } from "react";

// ===================== CONSTANTS =====================
const GROUP_ORDER = ["DELIVERED","NDR","RTO","IN TRANSIT","OFD","SHIPPED","CANCELLED","PICKUP","PENDING","OTHER"];
const SHIPPED_GROUPS = ["DELIVERED","NDR","RTO","IN TRANSIT","OFD","SHIPPED","OTHER"];
const SG = {
  DELIVERED:{label:"Delivered",c:"#34d399"},NDR:{label:"NDR",c:"#fbbf24"},RTO:{label:"RTO",c:"#f87171"},
  "IN TRANSIT":{label:"In Transit",c:"#60a5fa"},OFD:{label:"Out for Delivery",c:"#a78bfa"},
  SHIPPED:{label:"Shipped",c:"#818cf8"},CANCELLED:{label:"Cancelled",c:"#6b7280"},
  PICKUP:{label:"Pickup",c:"#2dd4bf"},PENDING:{label:"Pending / New",c:"#94a3b8"},OTHER:{label:"Other",c:"#c084fc"},
};

// ===================== STORAGE =====================
const COST_KEY = "adsmit-sku-costs";
const TOKEN_KEY = "adsmit-sr-token";
const CREDS_KEY = "adsmit-sr-creds";

async function loadCosts() {
  try { const r = await window.storage.get(COST_KEY); return r ? JSON.parse(r.value) : {}; }
  catch { return {}; }
}
async function saveCosts(data) {
  try { await window.storage.set(COST_KEY, JSON.stringify(data)); } catch(e) { console.error("Save costs error:", e); }
}
async function loadToken() {
  try { const r = await window.storage.get(TOKEN_KEY); return r ? r.value : null; }
  catch { return null; }
}
async function saveToken(t) {
  try { if (t) await window.storage.set(TOKEN_KEY, t); else await window.storage.delete(TOKEN_KEY); } catch {}
}
async function loadCreds() {
  try { const r = await window.storage.get(CREDS_KEY); return r ? JSON.parse(r.value) : null; }
  catch { return null; }
}
async function saveCreds(email, pw) {
  try { await window.storage.set(CREDS_KEY, JSON.stringify({ email, pw })); } catch {}
}

// ===================== STATUS =====================
function classify(raw) {
  if (!raw) return "PENDING"; const s = raw.toUpperCase().trim();
  if (s.includes("UNDELIVERED")) return "NDR";
  if (s.includes("RTO")) return "RTO";
  if (s.includes("DELIVERED") && !s.includes("NOT") && !s.includes("OUT FOR")) return "DELIVERED";
  if (s.includes("OUT FOR DELIVERY")) return "OFD";
  if (s.includes("OUT FOR PICKUP") || s.includes("PICKED UP")) return "PICKUP";
  if (s.includes("IN TRANSIT") || s.includes("INTRANSIT") || s.includes("EN-ROUTE") || s.includes("AT DESTINATION") || s.includes("REACHED DESTINATION")) return "IN TRANSIT";
  if (s.includes("SHIPPED")) return "SHIPPED";
  if (s.includes("CANCEL")) return "CANCELLED";
  if (s.includes("PICKUP")) return "PICKUP";
  if (s.includes("PENDING") || s.includes("NEW ORDER") || s.includes("CREATED")) return "PENDING";
  return "OTHER";
}

// ===================== CSV PARSER =====================
function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim()); if (lines.length < 2) return [];
  const pl = (line) => { const f = []; let c = "", q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"') q = !q; else if (ch === ',' && !q) { f.push(c.trim()); c = ""; } else c += ch; } f.push(c.trim()); return f; };
  const h = pl(lines[0]).map(x => x.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
  const fi = (kws) => h.findIndex(x => kws.some(k => x.includes(k)));
  const cols = { sku: fi(["master_sku","sku","channel_sku"]), status: fi(["status"]), id: fi(["order_id","order_no"]),
    awb: fi(["awb","tracking"]), date: fi(["shiprocket_created","created_at","date"]),
    courier: fi(["courier_company","courier"]), city: fi(["address_city","city"]),
    state: fi(["address_state","state"]), pay: fi(["payment_method","payment"]),
    ndrR: fi(["latest_ndr_reason","ndr_reason"]), rtoR: fi(["rto_reason"]),
    amt: fi(["order_total","product_price","total"]), pin: fi(["address_pincode","pincode","pin"]) };
  const orders = [];
  for (let i = 1; i < lines.length; i++) {
    const f = pl(lines[i]); if (f.length < 2) continue;
    const rawStatus = cols.status !== -1 ? (f[cols.status] || "") : "";
    const sku = cols.sku !== -1 ? (f[cols.sku] || "N/A") : "N/A";
    if (!sku && !rawStatus) continue;
    const g = classify(rawStatus);
    const dateStr = cols.date !== -1 ? (f[cols.date] || "") : "";
    const rawPin = cols.pin !== -1 ? (f[cols.pin] || "") : "";
    const pincode = rawPin ? String(rawPin).replace(/\.0$/, "").trim() : "";
    orders.push({ id: cols.id !== -1 ? f[cols.id] : i, sku: sku || "N/A", rawStatus, group: g, shipped: SHIPPED_GROUPS.includes(g),
      dateStr, dateObj: dateStr ? new Date(dateStr) : null,
      awb: cols.awb !== -1 ? (f[cols.awb] || "\u2014") : "\u2014",
      courier: cols.courier !== -1 ? (f[cols.courier] || "\u2014") : "\u2014",
      city: cols.city !== -1 ? (f[cols.city] || "\u2014") : "\u2014",
      state: cols.state !== -1 ? (f[cols.state] || "\u2014") : "\u2014",
      pincode,
      payment: cols.pay !== -1 ? (f[cols.pay] || "\u2014") : "\u2014",
      ndrReason: cols.ndrR !== -1 ? (f[cols.ndrR] || "") : "",
      rtoReason: cols.rtoR !== -1 ? (f[cols.rtoR] || "") : "",
      amount: cols.amt !== -1 ? parseFloat(f[cols.amt]) || 0 : 0 });
  }
  return orders;
}

// ===================== SHIPROCKET API =====================
async function srAuth(email, password) {
  const r = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!r.ok) throw new Error("Login failed. Check credentials.");
  return (await r.json()).token;
}

async function srFetchOrders(token, onProgress) {
  let all = [], pg = 1, more = true;
  while (more && pg <= 30) {
    onProgress?.(`Fetching page ${pg}...`);
    const r = await fetch(`https://apiv2.shiprocket.in/v1/external/orders?page=${pg}&per_page=50&sort=created_at&sort_dir=DESC`, {
      headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Fetch failed (page ${pg}). Token may be expired.`);
    const d = await r.json(); const o = d?.data || [];
    if (!o.length) more = false;
    else { all = [...all, ...o]; pg++; if (o.length < 50) more = false; }
  }
  onProgress?.(`Processing ${all.length} orders...`);
  return all.map(o => {
    const p = o.products || o.order_items || []; const sku = p[0]?.sku || p[0]?.channel_sku || "N/A";
    const sh = o.shipments || []; const l = sh[sh.length - 1];
    const rs = l?.status || o.status || o.shipment_status || "PENDING";
    const g = classify(rs); const dateStr = o.created_at || "";
    return { id: o.id, sku, rawStatus: rs, group: g, shipped: SHIPPED_GROUPS.includes(g),
      dateStr, dateObj: dateStr ? new Date(dateStr) : null,
      awb: l?.awb || o.awb_code || "\u2014", courier: l?.courier_name || "\u2014",
      city: o.customer_city || "\u2014", state: o.customer_state || "\u2014",
      pincode: o.customer_pincode ? String(o.customer_pincode) : "",
      payment: o.payment_method || "\u2014", ndrReason: "", rtoReason: "",
      amount: parseFloat(o.sub_total) || 0 };
  });
}

// ===================== ANALYTICS =====================
function useAnalytics(orders) {
  return useMemo(() => {
    const total = orders.length, shipped = orders.filter(o => o.shipped).length;
    const groups = {}; GROUP_ORDER.forEach(g => groups[g] = 0);
    const skuMap = {}, courierMap = {}, stateMap = {}, ndrSub = {}, rtoSub = {}, ndrR = {}, rtoR = {};
    orders.forEach(o => {
      groups[o.group] = (groups[o.group] || 0) + 1;
      if (!skuMap[o.sku]) { skuMap[o.sku] = { sku: o.sku, total: 0, shipped: 0, totalAmt: 0 }; GROUP_ORDER.forEach(g => skuMap[o.sku][g] = 0); }
      skuMap[o.sku].total++; skuMap[o.sku][o.group]++; skuMap[o.sku].totalAmt += o.amount; if (o.shipped) skuMap[o.sku].shipped++;
      if (o.group === "NDR" || o.group === "RTO") {
        courierMap[o.courier] = courierMap[o.courier] || { NDR: 0, RTO: 0 }; courierMap[o.courier][o.group]++;
        if (o.state !== "\u2014") { stateMap[o.state] = stateMap[o.state] || { NDR: 0, RTO: 0 }; stateMap[o.state][o.group]++; }
      }
      if (o.group === "NDR") { ndrSub[o.rawStatus || "Undelivered"] = (ndrSub[o.rawStatus || "Undelivered"] || 0) + 1; ndrR[o.ndrReason || "Not specified"] = (ndrR[o.ndrReason || "Not specified"] || 0) + 1; }
      if (o.group === "RTO") { rtoSub[o.rawStatus || "RTO"] = (rtoSub[o.rawStatus || "RTO"] || 0) + 1; rtoR[o.rtoReason || "Not specified"] = (rtoR[o.rtoReason || "Not specified"] || 0) + 1; }
    });
    const sort = m => Object.entries(m).sort((a, b) => b[1] - a[1]);
    const sortM = m => Object.entries(m).sort((a, b) => (b[1].NDR + b[1].RTO) - (a[1].NDR + a[1].RTO));
    return { total, shipped, groups, skuStats: Object.values(skuMap).sort((a, b) => b.total - a.total),
      sortedCourier: sortM(courierMap), sortedState: sortM(stateMap).slice(0, 10),
      sortedNdrSub: sort(ndrSub), sortedRtoSub: sort(rtoSub), sortedNdrR: sort(ndrR), sortedRtoR: sort(rtoR),
      delPct: shipped > 0 ? ((groups.DELIVERED / shipped) * 100).toFixed(1) : "0.0",
      ndrPct: shipped > 0 ? ((groups.NDR / shipped) * 100).toFixed(1) : "0.0",
      rtoPct: shipped > 0 ? ((groups.RTO / shipped) * 100).toFixed(1) : "0.0" };
  }, [orders]);
}

// ===================== COMPONENTS =====================
const Logo = ({ s = 32 }) => (
  <svg width={s} height={s} viewBox="0 0 40 40" fill="none">
    <rect width="40" height="40" rx="10" fill="#0d9488" />
    <path d="M10 26L20 12L30 26" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15 26L20 18L25 26" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity=".5" />
  </svg>
);

function KPI({ label, value, sub, color, sub2 }) {
  return (
    <div style={Z.kpi}>
      <div style={Z.kpiLabel}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-1px", color: color || "#e2e8f0", lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ color: "#64748b", fontSize: 11, marginTop: 4 }}>{sub}</div>}
      {sub2 && <div style={{ color: "#4a7a7a", fontSize: 10, marginTop: 2 }}>{sub2}</div>}
    </div>
  );
}

function GroupBar({ groups, total }) {
  return (
    <div style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", background: "#0c1a1a" }}>
      {GROUP_ORDER.map(g => { const c = groups[g] || 0; if (!c) return null;
        return <div key={g} title={`${SG[g].label}: ${c} (${((c / total) * 100).toFixed(1)}%)`} style={{ height: "100%", width: `${(c / total) * 100}%`, background: SG[g].c, minWidth: 2 }} />;
      })}
    </div>
  );
}

function Pills({ items, color }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {items.map(([s, c]) => (
        <div key={s} style={{ background: color + "18", border: `1px solid ${color}33`, borderRadius: 8, padding: "5px 12px", fontSize: 12 }}>
          <span style={{ color, fontWeight: 700 }}>{c}</span><span style={{ color: "#94a3b8", marginLeft: 6 }}>{s}</span>
        </div>
      ))}
    </div>
  );
}

function DateFilter({ dateFrom, dateTo, setDateFrom, setDateTo, onApply, totalInRange, totalAll }) {
  const presets = [
    { label: "Last 7d", fn: () => { const d = new Date(); d.setDate(d.getDate() - 7); return d; } },
    { label: "Last 15d", fn: () => { const d = new Date(); d.setDate(d.getDate() - 15); return d; } },
    { label: "Last 30d", fn: () => { const d = new Date(); d.setDate(d.getDate() - 30); return d; } },
    { label: "All time", fn: () => null },
  ];
  const fmt = d => d ? d.toISOString().split("T")[0] : "";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "10px 28px", background: "#06100f", borderBottom: "1px solid #1a2e2e" }}>
      <span style={{ fontSize: 11, color: "#4a7a7a", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px" }}>Date Range</span>
      {presets.map(p => (
        <button key={p.label} onClick={() => { const from = p.fn(); setDateFrom(from ? fmt(from) : ""); setDateTo(""); setTimeout(onApply, 50); }}
          style={{ padding: "5px 12px", background: "#0f2626", border: "1px solid #1a3a3a", borderRadius: 6, color: "#5eead4", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>{p.label}</button>
      ))}
      <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} style={{ ...Z.input, width: 130, padding: "5px 8px", fontSize: 12 }} />
      <span style={{ color: "#4a7a7a" }}>→</span>
      <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} style={{ ...Z.input, width: 130, padding: "5px 8px", fontSize: 12 }} />
      <button onClick={onApply} style={{ padding: "5px 14px", background: "#0d9488", border: "none", borderRadius: 6, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Apply</button>
      <span style={{ fontSize: 11, color: "#64748b" }}>Showing <strong style={{ color: "#5eead4" }}>{totalInRange}</strong> of {totalAll} orders</span>
    </div>
  );
}

// ===================== COST MANAGER =====================
function CostManager({ skuList, costs, setCosts, skuStats }) {
  const [editSku, setEditSku] = useState(null);
  const [form, setForm] = useState({ sp: "", pc: "", sc: "", ac: "", oc: "" });

  // Auto-fill selling prices from CSV on first load
  useEffect(() => {
    if (!skuStats?.length) return;
    let changed = false;
    const next = { ...costs };
    skuStats.forEach(s => {
      if (!next[s.sku]) next[s.sku] = {};
      if (!next[s.sku].sp && s.totalAmt > 0 && s.total > 0) {
        next[s.sku].sp = Math.round(s.totalAmt / s.total).toString();
        changed = true;
      }
    });
    if (changed) { setCosts(next); saveCosts(next); }
  }, [skuStats]);

  const startEdit = (sku) => {
    const c = costs[sku] || {};
    setForm({ sp: c.sp || "", pc: c.pc || "", sc: c.sc || "", ac: c.ac || "", oc: c.oc || "" });
    setEditSku(sku);
  };
  const saveEdit = () => {
    if (!editSku) return;
    const next = { ...costs, [editSku]: { sp: form.sp, pc: form.pc, sc: form.sc, ac: form.ac, oc: form.oc } };
    setCosts(next); saveCosts(next); setEditSku(null);
  };

  const [bulkField, setBulkField] = useState("sc");
  const [bulkValue, setBulkValue] = useState("");
  const [selectedSkus, setSelectedSkus] = useState(new Set());
  const fields = { sp: "Selling Price", pc: "Product Cost", sc: "Shipping", ac: "Ad CPA", oc: "Other" };

  const toggleSku = (sku) => {
    const next = new Set(selectedSkus);
    if (next.has(sku)) next.delete(sku); else next.add(sku);
    setSelectedSkus(next);
  };
  const selectAll = () => setSelectedSkus(new Set(skuList));
  const selectNone = () => setSelectedSkus(new Set());

  const bulkApplySelected = (field, value) => {
    const target = selectedSkus.size > 0 ? [...selectedSkus] : skuList;
    const next = { ...costs };
    target.forEach(sku => { if (!next[sku]) next[sku] = {}; next[sku][field] = value; });
    setCosts(next); saveCosts(next);
  };

  return (
    <div style={{ paddingTop: 20 }}>
      {/* Bulk apply */}
      <div style={Z.card}>
        <h3 style={Z.secTitle}>Bulk update costs</h3>
        <p style={{ fontSize: 12, color: "#4a7a7a", marginTop: 4 }}>Select SKUs below, pick a field & value, and apply. <strong style={{ color: "#5eead4" }}>Selling Price auto-fills from CSV avg.</strong></p>

        {/* SKU selector chips */}
        <div style={{ marginTop: 14, marginBottom: 14 }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "#4a7a7a", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".5px" }}>Select SKUs</span>
            <button onClick={selectAll} style={{ padding: "3px 10px", background: "#134e4a", border: "none", borderRadius: 5, color: "#5eead4", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>All</button>
            <button onClick={selectNone} style={{ padding: "3px 10px", background: "transparent", border: "1px solid #1a3a3a", borderRadius: 5, color: "#64748b", fontSize: 10, fontWeight: 600, cursor: "pointer" }}>None</button>
            <span style={{ fontSize: 11, color: "#5eead4", fontWeight: 600 }}>{selectedSkus.size > 0 ? `${selectedSkus.size} selected` : `All ${skuList.length} SKUs (default)`}</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {skuList.map(sku => {
              const active = selectedSkus.has(sku);
              return (
                <button key={sku} onClick={() => toggleSku(sku)} style={{
                  padding: "5px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer",
                  background: active ? "#0d948830" : "#0c1a1a",
                  border: active ? "1px solid #0d9488" : "1px solid #1a3a3a",
                  color: active ? "#5eead4" : "#64748b",
                }}>{sku}</button>
              );
            })}
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <label style={Z.label}>Field</label>
            <select style={{ ...Z.input, width: 160, cursor: "pointer" }} value={bulkField} onChange={e => setBulkField(e.target.value)}>
              {Object.entries(fields).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label style={Z.label}>Value (₹)</label>
            <input style={{ ...Z.input, width: 120 }} type="number" placeholder="65" value={bulkValue} onChange={e => setBulkValue(e.target.value)} />
          </div>
          <button onClick={() => { if (bulkValue) bulkApplySelected(bulkField, bulkValue); }} style={{ ...Z.btn, width: "auto", padding: "10px 24px", marginTop: 0 }}>
            Apply to {selectedSkus.size > 0 ? `${selectedSkus.size} SKUs` : `all ${skuList.length} SKUs`}
          </button>
        </div>
      </div>

      {/* Per-SKU table */}
      <div style={Z.card}>
        <h3 style={Z.secTitle}>Per-SKU costs</h3>
        <div style={{ overflowX: "auto", marginTop: 14 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}>
            <thead><tr>
              <th style={Z.th}>SKU</th>
              {Object.values(fields).map(f => <th key={f} style={{ ...Z.th, textAlign: "center" }}>{f}</th>)}
              <th style={{ ...Z.th, textAlign: "center" }}>Action</th>
            </tr></thead>
            <tbody>
              {skuList.map(sku => {
                const c = costs[sku] || {};
                const isEditing = editSku === sku;
                return (
                  <tr key={sku} style={{ borderBottom: "1px solid #1a2e2e" }}>
                    <td style={Z.tdSku}>{sku}</td>
                    {Object.keys(fields).map(f => (
                      <td key={f} style={{ ...Z.td, textAlign: "center" }}>
                        {isEditing ? (
                          <input style={{ ...Z.input, width: 80, padding: "6px 8px", fontSize: 12, textAlign: "center" }} type="number" value={form[f]} onChange={e => setForm({ ...form, [f]: e.target.value })} />
                        ) : (
                          <span style={{ color: c[f] ? "#e2e8f0" : "#334155", fontWeight: c[f] ? 600 : 400 }}>{c[f] ? `₹${c[f]}` : "—"}</span>
                        )}
                      </td>
                    ))}
                    <td style={{ ...Z.td, textAlign: "center" }}>
                      {isEditing ? (
                        <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
                          <button onClick={saveEdit} style={{ padding: "4px 12px", background: "#0d9488", border: "none", borderRadius: 6, color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>Save</button>
                          <button onClick={() => setEditSku(null)} style={{ padding: "4px 12px", background: "transparent", border: "1px solid #1a3a3a", borderRadius: 6, color: "#64748b", fontSize: 11, cursor: "pointer" }}>Cancel</button>
                        </div>
                      ) : (
                        <button onClick={() => startEdit(sku)} style={{ padding: "4px 12px", background: "transparent", border: "1px solid #1a3a3a", borderRadius: 6, color: "#5eead4", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Edit</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ===================== BREAKEVEN =====================
function Breakeven({ skuStats, costs }) {
  const [sel, setSel] = useState("");
  const skuData = useMemo(() => sel ? skuStats.find(s => s.sku === sel) : null, [sel, skuStats]);
  const c = costs[sel] || {};
  const sp = parseFloat(c.sp) || 0, pc = parseFloat(c.pc) || 0, sc = parseFloat(c.sc) || 0, ac = parseFloat(c.ac) || 0, oc = parseFloat(c.oc) || 0;
  const hasCosts = sp > 0;
  const metrics = useMemo(() => {
    if (!skuData || !sp) return null;
    const sh = skuData.shipped, del = skuData.DELIVERED, rto = skuData.RTO;
    const delPct = sh > 0 ? (del / sh * 100) : 0, rtoPct = sh > 0 ? (rto / sh * 100) : 0;
    const rev100 = delPct * sp, cost100 = 100 * (pc + sc + ac + oc);
    const profit100 = rev100 - cost100, profitPer = profit100 / 100;
    const beDel = sp > 0 ? ((pc + sc + ac + oc) / sp * 100) : 0;
    const maxAd = (delPct / 100) * sp - pc - sc - oc - 30;
    const costPerDel = delPct > 0 ? cost100 / delPct : 0;
    const roas = (100 * ac) > 0 ? rev100 / (100 * ac) : 0;
    const totalProfit = profitPer * sh;
    const totalRev = sp * del;
    const totalCost = (pc + sc + ac + oc) * sh;
    return { sh, del, rto, delPct, rtoPct, rev100, cost100, profit100, profitPer, beDel, maxAd, costPerDel, roas, ok: profit100 > 0, totalProfit, totalRev, totalCost, ndr: skuData.NDR, ndrPct: sh > 0 ? (skuData.NDR / sh * 100) : 0 };
  }, [skuData, sp, pc, sc, ac, oc]);

  const mc = (label, value, color, sub) => (
    <div style={{ flex: "1 1 140px", background: "#0a1e1e", border: "1px solid #1a3a3a33", borderRadius: 12, padding: "14px 16px" }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".7px", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: color || "#e2e8f0", letterSpacing: "-1px" }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: "#4a7a7a", marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={Z.card}>
        <h3 style={{ ...Z.secTitle, fontSize: 16 }}>Breakeven Calculator</h3>
        <p style={{ fontSize: 12, color: "#4a7a7a", marginTop: 4 }}>Select a SKU — costs auto-load from saved data. Update costs in the "Cost Manager" tab.</p>
        <div style={{ marginTop: 14 }}>
          <select style={{ ...Z.input, cursor: "pointer", maxWidth: 400 }} value={sel} onChange={e => setSel(e.target.value)}>
            <option value="">— Choose a SKU —</option>
            {skuStats.map(s => { const h = costs[s.sku]; return <option key={s.sku} value={s.sku}>{s.sku} ({s.shipped} shipped) {h?.sp ? "✓" : ""}</option>; })}
          </select>
        </div>
        {sel && !hasCosts && (
          <div style={{ marginTop: 14, padding: "14px 18px", background: "#fbbf2412", border: "1px solid #fbbf2433", borderRadius: 10, fontSize: 13, color: "#fbbf24" }}>
            No costs saved for <strong>{sel}</strong>. Go to <strong>Cost Manager</strong> tab to add selling price & costs first.
          </div>
        )}
      </div>

      {metrics && (
        <>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 16 }}>
            <div style={{ flex: "1 1 200px", background: metrics.ok ? "linear-gradient(165deg,#052e1f,#0a1e1e)" : "linear-gradient(165deg,#2e0f0f,#1e0a0a)", border: `1px solid ${metrics.ok ? "#34d39933" : "#f8717133"}`, borderRadius: 16, padding: "22px 24px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 6 }}>Profit per shipped order</div>
              <div style={{ fontSize: 34, fontWeight: 800, color: metrics.ok ? "#34d399" : "#f87171", letterSpacing: "-2px" }}>₹{metrics.profitPer.toFixed(2)}</div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>SP ₹{sp} — Costs ₹{(pc + sc + ac + oc)} × all shipped, revenue only from {metrics.delPct.toFixed(0)}% delivered</div>
            </div>
            <div style={{ flex: "1 1 200px", background: metrics.ok ? "linear-gradient(165deg,#052e1f,#0a1e1e)" : "linear-gradient(165deg,#2e0f0f,#1e0a0a)", border: `1px solid ${metrics.ok ? "#34d39933" : "#f8717133"}`, borderRadius: 16, padding: "22px 24px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 6 }}>Total P&L on {metrics.sh} shipped</div>
              <div style={{ fontSize: 34, fontWeight: 800, color: metrics.ok ? "#34d399" : "#f87171", letterSpacing: "-2px" }}>₹{metrics.totalProfit.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>Rev ₹{metrics.totalRev.toLocaleString("en-IN", { maximumFractionDigits: 0 })} — Cost ₹{metrics.totalCost.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</div>
            </div>
            <div style={{ flex: "1 1 200px", background: "linear-gradient(165deg,#0f2626,#0a1e1e)", border: "1px solid #1a3a3a33", borderRadius: 16, padding: "22px 24px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 6 }}>Per 100 shipped</div>
              <div style={{ fontSize: 34, fontWeight: 800, color: metrics.ok ? "#34d399" : "#f87171", letterSpacing: "-2px" }}>₹{metrics.profit100.toFixed(0)}</div>
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>Rev ₹{metrics.rev100.toFixed(0)} — Cost ₹{metrics.cost100.toFixed(0)}</div>
            </div>
          </div>

          <div style={Z.card}>
            <h3 style={Z.secTitle}>Key metrics</h3>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
              {mc("Breakeven Del %", `${metrics.beDel.toFixed(1)}%`, metrics.delPct >= metrics.beDel ? "#34d399" : "#f87171",
                metrics.delPct >= metrics.beDel ? `Current ${metrics.delPct.toFixed(1)}% above BE` : `Need +${(metrics.beDel - metrics.delPct).toFixed(1)}% more`)}
              {mc("Max CPA for ₹30 profit", metrics.maxAd > 0 ? `₹${metrics.maxAd.toFixed(0)}` : "N/A", metrics.maxAd > 0 ? "#5eead4" : "#f87171", metrics.maxAd > 0 ? `Current CPA: ₹${ac}` : "Reduce costs first")}
              {mc("ROAS", `${metrics.roas.toFixed(1)}x`, metrics.roas >= 2 ? "#34d399" : metrics.roas >= 1 ? "#fbbf24" : "#f87171")}
              {mc("Cost / Delivered", `₹${metrics.costPerDel.toFixed(0)}`, metrics.costPerDel < sp ? "#34d399" : "#f87171", `SP: ₹${sp}`)}
            </div>
          </div>

          <div style={Z.card}>
            <h3 style={Z.secTitle}>Cost breakdown per 100 shipped</h3>
            <div style={{ marginTop: 14 }}>
              {[{ l: "Revenue", v: metrics.rev100, c: "#34d399" }].map(r => (
                <div key={r.l} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <div style={{ width: 110, fontSize: 12, color: "#94a3b8", textAlign: "right" }}>{r.l}</div>
                  <div style={{ flex: 1, height: 26, background: "#0c1a1a", borderRadius: 6, position: "relative" }}>
                    <div style={{ height: "100%", width: "100%", background: r.c, opacity: .2, borderRadius: 6 }} />
                    <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 12, fontWeight: 700, color: r.c }}>₹{r.v.toFixed(0)}</span>
                  </div>
                </div>
              ))}
              {[{ l: "Product", v: 100 * pc, c: "#f87171" }, { l: "Shipping (flat)", v: 100 * sc, c: "#fbbf24" }, { l: "Ad Cost (CPA)", v: 100 * ac, c: "#a78bfa" }, { l: "Other", v: 100 * oc, c: "#6b7280" }].map(r => (
                <div key={r.l} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 5 }}>
                  <div style={{ width: 110, fontSize: 12, color: "#94a3b8", textAlign: "right" }}>{r.l}</div>
                  <div style={{ flex: 1, height: 20, background: "#0c1a1a", borderRadius: 4, position: "relative" }}>
                    <div style={{ height: "100%", width: `${metrics.rev100 > 0 ? (r.v / metrics.rev100 * 100) : 0}%`, background: r.c, opacity: .3, borderRadius: 4 }} />
                    <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: 11, fontWeight: 600, color: r.c }}>₹{r.v.toFixed(0)}</span>
                  </div>
                </div>
              ))}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, paddingTop: 10, borderTop: "1px solid #1a3a3a" }}>
                <div style={{ width: 110, fontSize: 13, color: "#e2e8f0", textAlign: "right", fontWeight: 700 }}>{metrics.ok ? "PROFIT" : "LOSS"}</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: metrics.ok ? "#34d399" : "#f87171" }}>₹{Math.abs(metrics.profit100).toFixed(0)}</div>
              </div>
            </div>
          </div>
        </>
      )}
      {!sel && <div style={{ ...Z.card, textAlign: "center", padding: "40px 20px" }}><div style={{ fontSize: 40, marginBottom: 8 }}>📊</div><div style={{ fontSize: 15, fontWeight: 600, color: "#94a3b8" }}>Select a SKU to calculate breakeven</div></div>}
    </div>
  );
}

// ===================== PINCODE RTO =====================
function PincodeRTO({ orders }) {
  const [minOrders, setMinOrders] = useState(3);
  const [search, setSearch] = useState("");

  const pinStats = useMemo(() => {
    const map = {};
    orders.forEach(o => {
      if (!o.pincode || !o.shipped) return;
      if (!map[o.pincode]) map[o.pincode] = { pin: o.pincode, shipped: 0, delivered: 0, rto: 0, ndr: 0, city: o.city, state: o.state };
      map[o.pincode].shipped++;
      if (o.group === "DELIVERED") map[o.pincode].delivered++;
      if (o.group === "RTO") map[o.pincode].rto++;
      if (o.group === "NDR") map[o.pincode].ndr++;
      if (o.city !== "\u2014") map[o.pincode].city = o.city;
      if (o.state !== "\u2014") map[o.pincode].state = o.state;
    });
    return Object.values(map)
      .filter(p => p.shipped >= minOrders)
      .map(p => ({ ...p, rtoPct: (p.rto / p.shipped * 100), delPct: (p.delivered / p.shipped * 100), ndrPct: (p.ndr / p.shipped * 100), failPct: ((p.rto + p.ndr) / p.shipped * 100) }))
      .sort((a, b) => b.rtoPct - a.rtoPct);
  }, [orders, minOrders]);

  const filtered = search ? pinStats.filter(p => p.pin.includes(search) || p.city.toLowerCase().includes(search.toLowerCase()) || p.state.toLowerCase().includes(search.toLowerCase())) : pinStats;

  const danger = filtered.filter(p => p.rtoPct >= 50);
  const warning = filtered.filter(p => p.rtoPct >= 20 && p.rtoPct < 50);
  const safe = filtered.filter(p => p.rtoPct < 20);
  const totalRtoFromDanger = danger.reduce((s, p) => s + p.rto, 0);

  const riskTag = (pct) => {
    if (pct >= 50) return { label: "BLOCK", bg: "#f8717125", color: "#f87171" };
    if (pct >= 25) return { label: "HIGH RISK", bg: "#fbbf2425", color: "#fbbf24" };
    if (pct >= 15) return { label: "WATCH", bg: "#60a5fa20", color: "#60a5fa" };
    return { label: "SAFE", bg: "#34d39918", color: "#34d399" };
  };

  return (
    <div style={{ paddingTop: 20 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 180px", background: "#f8717112", border: "1px solid #f8717133", borderRadius: 16, padding: "22px 24px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 6 }}>Dangerous pincodes (50%+ RTO)</div>
          <div style={{ fontSize: 34, fontWeight: 800, color: "#f87171", letterSpacing: "-2px" }}>{danger.length}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{totalRtoFromDanger} RTO orders from these pincodes</div>
        </div>
        <div style={{ flex: "1 1 180px", background: "#fbbf2412", border: "1px solid #fbbf2433", borderRadius: 16, padding: "22px 24px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 6 }}>High risk (20-50% RTO)</div>
          <div style={{ fontSize: 34, fontWeight: 800, color: "#fbbf24", letterSpacing: "-2px" }}>{warning.length}</div>
        </div>
        <div style={{ flex: "1 1 180px", background: "#34d39912", border: "1px solid #34d39933", borderRadius: 16, padding: "22px 24px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 6 }}>Safe pincodes (&lt;20% RTO)</div>
          <div style={{ fontSize: 34, fontWeight: 800, color: "#34d399", letterSpacing: "-2px" }}>{safe.length}</div>
        </div>
        <div style={{ flex: "1 1 180px", background: "linear-gradient(165deg,#0f2626,#0a1e1e)", border: "1px solid #1a3a3a33", borderRadius: 16, padding: "22px 24px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 6 }}>Total pincodes analyzed</div>
          <div style={{ fontSize: 34, fontWeight: 800, color: "#5eead4", letterSpacing: "-2px" }}>{pinStats.length}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>with {minOrders}+ shipped orders</div>
        </div>
      </div>

      <div style={Z.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 14 }}>
          <h3 style={Z.secTitle}>Pincode-level RTO analysis</h3>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <label style={{ fontSize: 11, color: "#4a7a7a" }}>Min orders:</label>
            <select style={{ ...Z.input, width: 70, padding: "5px 8px", fontSize: 12 }} value={minOrders} onChange={e => setMinOrders(parseInt(e.target.value))}>
              {[2, 3, 5, 10, 15].map(v => <option key={v} value={v}>{v}+</option>)}
            </select>
            <input style={Z.search} placeholder="Search pincode / city / state..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 750 }}>
            <thead><tr>
              <th style={Z.th}>Pincode</th><th style={Z.th}>City</th><th style={Z.th}>State</th>
              <th style={{ ...Z.th, textAlign: "center" }}>Shipped</th>
              <th style={{ ...Z.th, textAlign: "center" }}>Delivered</th>
              <th style={{ ...Z.th, textAlign: "center" }}>Del %</th>
              <th style={{ ...Z.th, textAlign: "center" }}>RTO</th>
              <th style={{ ...Z.th, textAlign: "center", background: "#f8717115", color: "#f87171" }}>RTO %</th>
              <th style={{ ...Z.th, textAlign: "center" }}>NDR</th>
              <th style={{ ...Z.th, textAlign: "center" }}>Risk</th>
            </tr></thead>
            <tbody>
              {filtered.map(p => {
                const risk = riskTag(p.rtoPct);
                return (
                  <tr key={p.pin} style={{ borderBottom: "1px solid #1a2e2e" }}>
                    <td style={{ ...Z.tdSku, color: risk.color }}>{p.pin}</td>
                    <td style={Z.td}>{p.city}</td>
                    <td style={Z.td}>{p.state}</td>
                    <td style={{ ...Z.td, textAlign: "center" }}>{p.shipped}</td>
                    <td style={{ ...Z.td, textAlign: "center", color: "#34d399", fontWeight: 600 }}>{p.delivered}</td>
                    <td style={{ ...Z.td, textAlign: "center" }}><span style={{ ...Z.badge, background: p.delPct >= 50 ? "#34d39918" : p.delPct >= 20 ? "#fbbf2418" : "#f8717118", color: p.delPct >= 50 ? "#34d399" : p.delPct >= 20 ? "#fbbf24" : "#f87171" }}>{p.delPct.toFixed(0)}%</span></td>
                    <td style={{ ...Z.td, textAlign: "center", color: "#f87171", fontWeight: 600 }}>{p.rto}</td>
                    <td style={{ ...Z.td, textAlign: "center", background: "#f871710a" }}><span style={{ fontWeight: 800, color: p.rtoPct >= 50 ? "#f87171" : p.rtoPct >= 20 ? "#fbbf24" : "#34d399" }}>{p.rtoPct.toFixed(0)}%</span></td>
                    <td style={{ ...Z.td, textAlign: "center", color: "#fbbf24" }}>{p.ndr}</td>
                    <td style={{ ...Z.td, textAlign: "center" }}><span style={{ padding: "3px 10px", borderRadius: 6, fontSize: 10, fontWeight: 700, background: risk.bg, color: risk.color }}>{risk.label}</span></td>
                  </tr>
                );
              })}
              {!filtered.length && <tr><td colSpan={10} style={{ ...Z.td, textAlign: "center", color: "#475569" }}>No pincodes match</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ===================== PRODUCT GROUPS =====================
function ProductGroups({ skuStats, orders, costs }) {
  const [customGroups, setCustomGroups] = useState({});
  const [editGroup, setEditGroup] = useState(null);
  const [groupName, setGroupName] = useState("");
  const [groupSkus, setGroupSkus] = useState(new Set());

  // Auto-detect groups from SKU name prefix (first word)
  const autoGroups = useMemo(() => {
    const map = {};
    skuStats.forEach(s => {
      const prefix = s.sku.split(/[\s_-]+/)[0];
      if (!prefix || prefix.length < 2) return;
      if (!map[prefix]) map[prefix] = [];
      map[prefix].push(s.sku);
    });
    // Only keep groups with 2+ SKUs
    return Object.fromEntries(Object.entries(map).filter(([, v]) => v.length > 1));
  }, [skuStats]);

  const allGroups = useMemo(() => {
    const merged = { ...autoGroups, ...customGroups };
    return Object.entries(merged).map(([name, skus]) => {
      const stats = { name, skus, total: 0, shipped: 0, delivered: 0, rto: 0, ndr: 0, totalAmt: 0, totalRev: 0, totalCost: 0 };
      skus.forEach(sku => {
        const s = skuStats.find(x => x.sku === sku);
        if (!s) return;
        stats.total += s.total; stats.shipped += s.shipped; stats.delivered += s.DELIVERED; stats.rto += s.RTO; stats.ndr += s.NDR; stats.totalAmt += s.totalAmt;
        const c = costs[sku] || {};
        const sp = parseFloat(c.sp) || 0, costPer = (parseFloat(c.pc) || 0) + (parseFloat(c.sc) || 0) + (parseFloat(c.ac) || 0) + (parseFloat(c.oc) || 0);
        stats.totalRev += sp * s.DELIVERED;
        stats.totalCost += costPer * s.shipped;
      });
      stats.delPct = stats.shipped > 0 ? (stats.delivered / stats.shipped * 100) : 0;
      stats.rtoPct = stats.shipped > 0 ? (stats.rto / stats.shipped * 100) : 0;
      stats.ndrPct = stats.shipped > 0 ? (stats.ndr / stats.shipped * 100) : 0;
      stats.profit = stats.totalRev - stats.totalCost;
      stats.profitPerOrder = stats.shipped > 0 ? stats.profit / stats.shipped : 0;
      stats.hasCosts = stats.totalRev > 0 || stats.totalCost > 0;
      return stats;
    }).sort((a, b) => b.shipped - a.shipped);
  }, [autoGroups, customGroups, skuStats, costs]);

  const fmt = v => v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const allSkus = skuStats.map(s => s.sku);

  const saveGroup = () => {
    if (!groupName.trim() || groupSkus.size === 0) return;
    setCustomGroups({ ...customGroups, [groupName.trim()]: [...groupSkus] });
    setEditGroup(null); setGroupName(""); setGroupSkus(new Set());
  };

  return (
    <div style={{ paddingTop: 20 }}>
      {/* Create custom group */}
      <div style={Z.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <h3 style={Z.secTitle}>Product groups</h3>
            <p style={{ fontSize: 12, color: "#4a7a7a", marginTop: 4 }}>Auto-detected from SKU names. Create custom groups below.</p>
          </div>
          {!editGroup && <button onClick={() => setEditGroup("new")} style={{ ...Z.btn, width: "auto", padding: "8px 20px", marginTop: 0, fontSize: 12 }}>+ Custom Group</button>}
        </div>

        {editGroup && (
          <div style={{ marginTop: 14, padding: 16, background: "#0c1a1a", borderRadius: 12, border: "1px solid #1a3a3a" }}>
            <label style={Z.label}>Group Name</label>
            <input style={{ ...Z.input, maxWidth: 250 }} placeholder="e.g. Cleaning Products" value={groupName} onChange={e => setGroupName(e.target.value)} />
            <label style={{ ...Z.label, marginTop: 12 }}>Select SKUs</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {allSkus.map(sku => (
                <button key={sku} onClick={() => { const n = new Set(groupSkus); if (n.has(sku)) n.delete(sku); else n.add(sku); setGroupSkus(n); }}
                  style={{ padding: "5px 12px", borderRadius: 8, fontSize: 11, fontWeight: 600, cursor: "pointer",
                    background: groupSkus.has(sku) ? "#0d948830" : "#040d0d", border: groupSkus.has(sku) ? "1px solid #0d9488" : "1px solid #1a3a3a",
                    color: groupSkus.has(sku) ? "#5eead4" : "#64748b" }}>{sku}</button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={saveGroup} style={{ padding: "8px 20px", background: "#0d9488", border: "none", borderRadius: 8, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>Save Group</button>
              <button onClick={() => { setEditGroup(null); setGroupName(""); setGroupSkus(new Set()); }} style={{ padding: "8px 20px", background: "transparent", border: "1px solid #1a3a3a", borderRadius: 8, color: "#64748b", fontSize: 12, cursor: "pointer" }}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Group cards */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 14 }}>
        {allGroups.map(g => (
          <div key={g.name} style={Z.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
              <div>
                <h3 style={{ ...Z.secTitle, fontSize: 16 }}>{g.name}</h3>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
                  {g.skus.map(s => <span key={s} style={{ padding: "3px 10px", borderRadius: 6, fontSize: 10, background: "#0c1a1a", border: "1px solid #1a3a3a", color: "#94a3b8" }}>{s}</span>)}
                </div>
              </div>
              {g.hasCosts && (
                <div style={{ padding: "8px 16px", borderRadius: 10, background: g.profit >= 0 ? "#34d39912" : "#f8717112", border: `1px solid ${g.profit >= 0 ? "#34d39933" : "#f8717133"}` }}>
                  <div style={{ fontSize: 10, color: "#4a7a7a", fontWeight: 600, textTransform: "uppercase" }}>Net Profit</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: g.profit >= 0 ? "#34d399" : "#f87171" }}>₹{fmt(g.profit)}</div>
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 14 }}>
              <div style={{ flex: "1 1 100px", background: "#040d0d", borderRadius: 10, padding: "10px 14px" }}>
                <div style={{ fontSize: 10, color: "#4a7a7a", fontWeight: 600, textTransform: "uppercase" }}>Shipped</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#5eead4" }}>{fmt(g.shipped)}</div>
              </div>
              <div style={{ flex: "1 1 100px", background: "#040d0d", borderRadius: 10, padding: "10px 14px" }}>
                <div style={{ fontSize: 10, color: "#4a7a7a", fontWeight: 600, textTransform: "uppercase" }}>Delivered</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#34d399" }}>{fmt(g.delivered)}</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>{g.delPct.toFixed(1)}%</div>
              </div>
              <div style={{ flex: "1 1 100px", background: "#040d0d", borderRadius: 10, padding: "10px 14px" }}>
                <div style={{ fontSize: 10, color: "#4a7a7a", fontWeight: 600, textTransform: "uppercase" }}>RTO</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#f87171" }}>{fmt(g.rto)}</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>{g.rtoPct.toFixed(1)}%</div>
              </div>
              <div style={{ flex: "1 1 100px", background: "#040d0d", borderRadius: 10, padding: "10px 14px" }}>
                <div style={{ fontSize: 10, color: "#4a7a7a", fontWeight: 600, textTransform: "uppercase" }}>NDR</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: "#fbbf24" }}>{fmt(g.ndr)}</div>
                <div style={{ fontSize: 11, color: "#64748b" }}>{g.ndrPct.toFixed(1)}%</div>
              </div>
              {g.hasCosts && (
                <div style={{ flex: "1 1 100px", background: "#040d0d", borderRadius: 10, padding: "10px 14px" }}>
                  <div style={{ fontSize: 10, color: "#4a7a7a", fontWeight: 600, textTransform: "uppercase" }}>Profit / Order</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: g.profitPerOrder >= 0 ? "#34d399" : "#f87171" }}>₹{g.profitPerOrder.toFixed(0)}</div>
                </div>
              )}
            </div>
          </div>
        ))}
        {!allGroups.length && <div style={{ ...Z.card, textAlign: "center", padding: "30px 20px", color: "#64748b" }}>No groups found. Create a custom group above.</div>}
      </div>
    </div>
  );
}

// ===================== NET PROFIT =====================
function NetProfit({ skuStats, costs }) {
  const [search, setSearch] = useState("");

  // Only include SKUs that have costs saved (at least selling price)
  const rows = useMemo(() => {
    return skuStats.map(s => {
      const c = costs[s.sku] || {};
      const sp = parseFloat(c.sp) || 0;
      const costPerOrder = (parseFloat(c.pc) || 0) + (parseFloat(c.sc) || 0) + (parseFloat(c.ac) || 0) + (parseFloat(c.oc) || 0);
      const hasCosts = sp > 0;
      const sh = s.shipped, del = s.DELIVERED;
      const delPct = sh > 0 ? (del / sh * 100) : 0;
      const totalRevenue = sp * del;
      const totalCost = costPerOrder * sh;
      const totalProfit = totalRevenue - totalCost;
      const profitPerOrder = sh > 0 ? totalProfit / sh : 0;
      return { sku: s.sku, total: s.total, sh, del, delPct, sp, costPerOrder, totalRevenue, totalCost, totalProfit, profitPerOrder, hasCosts, ndr: s.NDR, rto: s.RTO };
    });
  }, [skuStats, costs]);

  const configured = rows.filter(r => r.hasCosts);
  const notConfigured = rows.filter(r => !r.hasCosts);
  const profitable = configured.filter(r => r.totalProfit >= 0);
  const losing = configured.filter(r => r.totalProfit < 0);

  // Grand totals (only from configured SKUs)
  const grandRevenue = configured.reduce((s, r) => s + r.totalRevenue, 0);
  const grandCost = configured.reduce((s, r) => s + r.totalCost, 0);
  const grandProfit = grandRevenue - grandCost;
  const grandShipped = configured.reduce((s, r) => s + r.sh, 0);
  const grandDelivered = configured.reduce((s, r) => s + r.del, 0);
  const grandProfitPerOrder = grandShipped > 0 ? grandProfit / grandShipped : 0;

  const fmt = v => v.toLocaleString("en-IN", { maximumFractionDigits: 0 });
  const isOk = grandProfit >= 0;

  return (
    <div style={{ paddingTop: 20 }}>
      {/* Grand total cards */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 220px", background: isOk ? "linear-gradient(165deg,#052e1f,#0a1e1e)" : "linear-gradient(165deg,#2e0f0f,#1e0a0a)", border: `1px solid ${isOk ? "#34d39933" : "#f8717133"}`, borderRadius: 16, padding: "24px 26px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 6 }}>Net profit (all SKUs)</div>
          <div style={{ fontSize: 38, fontWeight: 800, color: isOk ? "#34d399" : "#f87171", letterSpacing: "-2px" }}>₹{fmt(grandProfit)}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>on {fmt(grandShipped)} shipped orders ({configured.length} SKUs with costs)</div>
        </div>
        <div style={{ flex: "1 1 180px", background: "linear-gradient(165deg,#0f2626,#0a1e1e)", border: "1px solid #1a3a3a33", borderRadius: 16, padding: "24px 26px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 6 }}>Total revenue</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: "#34d399", letterSpacing: "-1px" }}>₹{fmt(grandRevenue)}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{fmt(grandDelivered)} delivered orders</div>
        </div>
        <div style={{ flex: "1 1 180px", background: "linear-gradient(165deg,#0f2626,#0a1e1e)", border: "1px solid #1a3a3a33", borderRadius: 16, padding: "24px 26px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 6 }}>Total cost</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: "#f87171", letterSpacing: "-1px" }}>₹{fmt(grandCost)}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{fmt(grandShipped)} shipped × costs</div>
        </div>
        <div style={{ flex: "1 1 150px", background: isOk ? "linear-gradient(165deg,#052e1f,#0a1e1e)" : "linear-gradient(165deg,#2e0f0f,#1e0a0a)", border: `1px solid ${isOk ? "#34d39933" : "#f8717133"}`, borderRadius: 16, padding: "24px 26px" }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 6 }}>Profit / order</div>
          <div style={{ fontSize: 30, fontWeight: 800, color: isOk ? "#34d399" : "#f87171", letterSpacing: "-1px" }}>₹{grandProfitPerOrder.toFixed(2)}</div>
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>avg across all shipped</div>
        </div>
      </div>

      {/* Profitable vs Losing summary */}
      <div style={{ display: "flex", gap: 14, marginTop: 14, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 200px", ...Z.card, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: "#34d39918", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>✅</div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#34d399" }}>{profitable.length} SKUs</div>
            <div style={{ fontSize: 12, color: "#64748b" }}>profitable — earning ₹{fmt(profitable.reduce((s, r) => s + r.totalProfit, 0))}</div>
          </div>
        </div>
        <div style={{ flex: "1 1 200px", ...Z.card, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: "#f8717118", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>❌</div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#f87171" }}>{losing.length} SKUs</div>
            <div style={{ fontSize: 12, color: "#64748b" }}>losing money — ₹{fmt(Math.abs(losing.reduce((s, r) => s + r.totalProfit, 0)))} loss</div>
          </div>
        </div>
        {notConfigured.length > 0 && (
          <div style={{ flex: "1 1 200px", ...Z.card, display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ width: 48, height: 48, borderRadius: 12, background: "#fbbf2418", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, flexShrink: 0 }}>⚠️</div>
            <div>
              <div style={{ fontSize: 22, fontWeight: 800, color: "#fbbf24" }}>{notConfigured.length} SKUs</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>no costs set — go to Cost Manager</div>
            </div>
          </div>
        )}
      </div>

      {/* Per-SKU profit table */}
      <div style={Z.card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
          <h3 style={Z.secTitle}>Per-SKU net profit</h3>
          <input style={Z.search} placeholder="Search SKU..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 850 }}>
            <thead><tr>
              <th style={Z.th}>SKU</th>
              <th style={{ ...Z.th, textAlign: "center" }}>Shipped</th>
              <th style={{ ...Z.th, textAlign: "center" }}>Delivered</th>
              <th style={{ ...Z.th, textAlign: "center" }}>Del %</th>
              <th style={{ ...Z.th, textAlign: "center" }}>SP</th>
              <th style={{ ...Z.th, textAlign: "center" }}>Cost / Order</th>
              <th style={{ ...Z.th, textAlign: "center", background: "#0d948815", color: "#5eead4" }}>Profit / Order</th>
              <th style={{ ...Z.th, textAlign: "center" }}>Total Revenue</th>
              <th style={{ ...Z.th, textAlign: "center" }}>Total Cost</th>
              <th style={{ ...Z.th, textAlign: "center", background: "#0d948815", color: "#5eead4" }}>Total Profit</th>
              <th style={{ ...Z.th, textAlign: "center" }}>Status</th>
            </tr></thead>
            <tbody>
              {configured.filter(r => !search || r.sku.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.totalProfit - a.totalProfit).map(r => (
                <tr key={r.sku} style={{ borderBottom: "1px solid #1a2e2e" }}>
                  <td style={Z.tdSku}>{r.sku}</td>
                  <td style={{ ...Z.td, textAlign: "center" }}>{r.sh}</td>
                  <td style={{ ...Z.td, textAlign: "center", color: "#34d399", fontWeight: 600 }}>{r.del}</td>
                  <td style={{ ...Z.td, textAlign: "center" }}>
                    <span style={{ ...Z.badge, background: r.delPct >= 50 ? "#34d39918" : r.delPct >= 20 ? "#fbbf2418" : "#f8717118", color: r.delPct >= 50 ? "#34d399" : r.delPct >= 20 ? "#fbbf24" : "#f87171" }}>{r.delPct.toFixed(1)}%</span>
                  </td>
                  <td style={{ ...Z.td, textAlign: "center" }}>₹{r.sp}</td>
                  <td style={{ ...Z.td, textAlign: "center" }}>₹{r.costPerOrder.toFixed(0)}</td>
                  <td style={{ ...Z.td, textAlign: "center", background: "#0d94880a" }}>
                    <span style={{ fontWeight: 800, fontSize: 13, color: r.profitPerOrder >= 0 ? "#34d399" : "#f87171" }}>₹{r.profitPerOrder.toFixed(2)}</span>
                  </td>
                  <td style={{ ...Z.td, textAlign: "center", color: "#94a3b8" }}>₹{fmt(r.totalRevenue)}</td>
                  <td style={{ ...Z.td, textAlign: "center", color: "#94a3b8" }}>₹{fmt(r.totalCost)}</td>
                  <td style={{ ...Z.td, textAlign: "center", background: "#0d94880a" }}>
                    <span style={{ fontWeight: 800, fontSize: 13, color: r.totalProfit >= 0 ? "#34d399" : "#f87171" }}>₹{fmt(r.totalProfit)}</span>
                  </td>
                  <td style={{ ...Z.td, textAlign: "center" }}>
                    <span style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: r.totalProfit >= 0 ? "#34d39918" : "#f8717118", color: r.totalProfit >= 0 ? "#34d399" : "#f87171" }}>
                      {r.totalProfit >= 0 ? "Profitable" : "Losing"}
                    </span>
                  </td>
                </tr>
              ))}
              {notConfigured.filter(r => !search || r.sku.toLowerCase().includes(search.toLowerCase())).map(r => (
                <tr key={r.sku} style={{ borderBottom: "1px solid #1a2e2e", opacity: 0.4 }}>
                  <td style={Z.tdSku}>{r.sku}</td>
                  <td style={{ ...Z.td, textAlign: "center" }}>{r.sh}</td>
                  <td style={{ ...Z.td, textAlign: "center" }}>{r.del}</td>
                  <td style={{ ...Z.td, textAlign: "center" }}>{r.delPct.toFixed(1)}%</td>
                  <td colSpan={7} style={{ ...Z.td, textAlign: "center", color: "#fbbf24", fontStyle: "italic" }}>No costs configured — add in Cost Manager</td>
                </tr>
              ))}
            </tbody>
            {configured.length > 1 && (
              <tfoot>
                <tr style={{ borderTop: "2px solid #0d9488" }}>
                  <td style={{ ...Z.tdSku, color: "#5eead4" }}>GRAND TOTAL</td>
                  <td style={{ ...Z.td, textAlign: "center", fontWeight: 700, color: "#5eead4" }}>{fmt(grandShipped)}</td>
                  <td style={{ ...Z.td, textAlign: "center", fontWeight: 700, color: "#34d399" }}>{fmt(grandDelivered)}</td>
                  <td style={{ ...Z.td, textAlign: "center", fontWeight: 700 }}>{grandShipped > 0 ? (grandDelivered / grandShipped * 100).toFixed(1) : 0}%</td>
                  <td style={{ ...Z.td, textAlign: "center" }}>—</td>
                  <td style={{ ...Z.td, textAlign: "center" }}>—</td>
                  <td style={{ ...Z.td, textAlign: "center", background: "#0d94880a" }}>
                    <span style={{ fontWeight: 800, color: isOk ? "#34d399" : "#f87171" }}>₹{grandProfitPerOrder.toFixed(2)}</span>
                  </td>
                  <td style={{ ...Z.td, textAlign: "center", fontWeight: 700, color: "#94a3b8" }}>₹{fmt(grandRevenue)}</td>
                  <td style={{ ...Z.td, textAlign: "center", fontWeight: 700, color: "#94a3b8" }}>₹{fmt(grandCost)}</td>
                  <td style={{ ...Z.td, textAlign: "center", background: "#0d94880a" }}>
                    <span style={{ fontWeight: 800, fontSize: 14, color: isOk ? "#34d399" : "#f87171" }}>₹{fmt(grandProfit)}</span>
                  </td>
                  <td style={{ ...Z.td, textAlign: "center" }}>
                    <span style={{ padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: isOk ? "#34d39918" : "#f8717118", color: isOk ? "#34d399" : "#f87171" }}>
                      {isOk ? "Net Positive" : "Net Loss"}
                    </span>
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}

// ===================== SKU TABLE =====================
function SkuTable({ data, filter, setFilter, costs }) {
  const fl = filter ? data.filter(d => d.sku.toLowerCase().includes(filter.toLowerCase())) : data;
  return (
    <div style={Z.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
        <h3 style={Z.secTitle}>SKU performance</h3>
        <input style={Z.search} placeholder="Search SKU..." value={filter} onChange={e => setFilter(e.target.value)} />
      </div>
      <div style={{ marginBottom: 10, fontSize: 11, color: "#4a7a7a", padding: "7px 12px", background: "#0d948812", borderRadius: 8 }}>
        📊 Del % on <strong style={{ color: "#5eead4" }}>shipped orders</strong>. Profit uses saved costs from Cost Manager.
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
          <thead><tr>
            <th style={Z.th}>SKU</th><th style={{ ...Z.th, textAlign: "center" }}>Total</th>
            <th style={{ ...Z.th, textAlign: "center", background: "#0d948815", color: "#5eead4" }}>Shipped</th>
            <th style={{ ...Z.th, textAlign: "center", background: "#0d948815", color: "#5eead4" }}>Del %</th>
            <th style={{ ...Z.th, textAlign: "center" }}>NDR %</th><th style={{ ...Z.th, textAlign: "center" }}>RTO %</th>
            <th style={{ ...Z.th, textAlign: "center" }}>Profit/Order</th>
            <th style={Z.th}>Distribution</th>
          </tr></thead>
          <tbody>{fl.map(row => {
            const sh = row.shipped, dp = sh > 0 ? (row.DELIVERED / sh * 100).toFixed(1) : "0.0", np = sh > 0 ? (row.NDR / sh * 100).toFixed(1) : "0.0", rp = sh > 0 ? (row.RTO / sh * 100).toFixed(1) : "0.0";
            const co = costs[row.sku] || {};
            const sp = parseFloat(co.sp) || 0, totC = (parseFloat(co.pc) || 0) + (parseFloat(co.sc) || 0) + (parseFloat(co.ac) || 0) + (parseFloat(co.oc) || 0);
            const ppo = sp > 0 && sh > 0 ? ((parseFloat(dp) / 100) * sp - totC) : null;
            const bc = (v, g, m) => ({ background: v >= g ? "#34d39918" : v >= m ? "#fbbf2418" : "#f8717118", color: v >= g ? "#34d399" : v >= m ? "#fbbf24" : "#f87171" });
            const rb = (v) => ({ background: v <= 3 ? "#34d39918" : v <= 10 ? "#fbbf2418" : "#f8717118", color: v <= 3 ? "#34d399" : v <= 10 ? "#fbbf24" : "#f87171" });
            return (
              <tr key={row.sku} style={{ borderBottom: "1px solid #1a2e2e" }}>
                <td style={Z.tdSku}>{row.sku}</td>
                <td style={{ ...Z.td, textAlign: "center", fontWeight: 600 }}>{row.total}</td>
                <td style={{ ...Z.td, textAlign: "center", fontWeight: 700, color: "#5eead4", background: "#0d94880a" }}>{sh}</td>
                <td style={{ ...Z.td, textAlign: "center", background: "#0d94880a" }}><span style={{ ...Z.badge, ...bc(parseFloat(dp), 50, 20) }}>{dp}%</span></td>
                <td style={{ ...Z.td, textAlign: "center" }}><span style={{ ...Z.badge, ...rb(parseFloat(np)) }}>{np}%</span></td>
                <td style={{ ...Z.td, textAlign: "center" }}><span style={{ ...Z.badge, ...rb(parseFloat(rp)) }}>{rp}%</span></td>
                <td style={{ ...Z.td, textAlign: "center" }}>
                  {ppo !== null ? <span style={{ fontWeight: 700, color: ppo >= 0 ? "#34d399" : "#f87171" }}>₹{ppo.toFixed(0)}</span> : <span style={{ color: "#334155" }}>—</span>}
                </td>
                <td style={Z.td}><GroupBar groups={row} total={row.total} /></td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </div>
  );
}

// ===================== LOGIN =====================
function LoginScreen({ onData, onCSV }) {
  const [email, setEmail] = useState(""); const [pw, setPw] = useState(""); const [mode, setMode] = useState("api");
  const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [progress, setProgress] = useState("");
  const [drag, setDrag] = useState(false); const fileRef = useRef(null);
  const [autoMsg, setAutoMsg] = useState(""); const [autoLoading, setAutoLoading] = useState(true);
  const [corsMsg, setCorsMsg] = useState("");

  // Auto-login on mount
  useEffect(() => {
    (async () => {
      setAutoMsg("Checking saved session...");
      const token = await loadToken();
      const creds = await loadCreds();
      if (token) {
        try {
          setAutoMsg("Fetching latest orders...");
          const orders = await srFetchOrders(token, setAutoMsg);
          if (orders.length) { onData(orders, "api"); return; }
        } catch (e) {
          const msg = e?.message || "";
          if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
            setAutoMsg(""); setAutoLoading(false); setMode("csv");
            setCorsMsg("Browser blocked Shiprocket API (CORS). Upload CSV export instead."); return;
          }
        }
      }
      if (creds?.email && creds?.pw) {
        try {
          setAutoMsg("Re-authenticating...");
          const newToken = await srAuth(creds.email, creds.pw);
          await saveToken(newToken);
          setAutoMsg("Fetching orders...");
          const orders = await srFetchOrders(newToken, setAutoMsg);
          if (orders.length) { onData(orders, "api"); return; }
        } catch (e) {
          const msg = e?.message || "";
          if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
            setAutoMsg(""); setAutoLoading(false); setMode("csv");
            setCorsMsg("Browser blocked Shiprocket API (CORS). Upload CSV export instead."); return;
          }
        }
      }
      setAutoMsg(""); setAutoLoading(false);
    })();
  }, []);

  const handleLogin = async () => {
    if (!email || !pw) { setError("Both fields required."); return; }
    setError(""); setLoading(true); setProgress("Authenticating...");
    try {
      const token = await srAuth(email, pw);
      await saveToken(token); await saveCreds(email, pw);
      setProgress("Fetching last 30 days orders...");
      const orders = await srFetchOrders(token, setProgress);
      onData(orders, "api");
    } catch (e) {
      const msg = e.message || "";
      if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("CORS")) {
        setError(""); setMode("csv");
        setCorsMsg("Shiprocket API is blocked by browser (CORS). Please upload your CSV export instead — it works perfectly here.");
      } else { setError(msg); }
      setLoading(false); setProgress("");
    }
  };

  const handleCSV = async (file) => {
    if (!file) return; setError(""); setLoading(true);
    try { const t = await file.text(); const o = parseCSV(t); if (!o.length) throw new Error("No orders."); onCSV(o); }
    catch (e) { setError(e.message); } setLoading(false);
  };

  if (autoLoading && autoMsg) return (
    <div style={Z.loadWrap}>
      <Logo s={48} />
      <div style={{ marginTop: 16, width: 40, height: 40, border: "3px solid #1a3a3a", borderTop: "3px solid #0d9488", borderRadius: "50%", animation: "spin .8s linear infinite" }} />
      <p style={{ color: "#5eead4", marginTop: 14, fontSize: 13, fontWeight: 600 }}>{autoMsg}</p>
      <p style={{ color: "#4a7a7a", fontSize: 11, marginTop: 6 }}>Auto-connecting to Shiprocket...</p>
    </div>
  );

  const tab = (t, lbl) => (
    <button onClick={() => { setMode(t); setError(""); }} style={{ flex: 1, padding: "11px 0", background: mode === t ? "linear-gradient(135deg,#134e4a,#0f3d3a)" : "transparent", border: "none", borderRadius: 8, color: mode === t ? "#5eead4" : "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{lbl}</button>
  );

  return (
    <div style={Z.loginWrap}>
      <div style={Z.loginCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}><Logo s={42} /><div><div style={{ fontSize: 22, fontWeight: 800, color: "#f0fdfa", letterSpacing: "-.5px" }}>Analytics Dashboard</div><div style={{ fontSize: 11, fontWeight: 600, color: "#5eead4", letterSpacing: "2px", textTransform: "uppercase" }}>by Adsmit</div></div></div>
        <p style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.6, margin: "14px 0 20px" }}>Connect Shiprocket to auto-fetch orders or upload CSV. Costs are saved on your device.</p>
        <div style={{ display: "flex", marginBottom: 18, background: "#0c1a1a", borderRadius: 10, padding: 3, border: "1px solid #1a3a3a" }}>{tab("api", "🔗 Shiprocket Login")}{tab("csv", "📄 Upload CSV")}</div>
        {error && <div style={Z.err}>{error}</div>}
        {progress && <div style={{ fontSize: 12, color: "#5eead4", marginBottom: 10 }}>{progress}</div>}
        {mode === "api" && (<>
          <div style={Z.hint}><span style={{ fontSize: 15 }}>💡</span><span>Use <strong style={{ color: "#cbd5e1" }}>API User</strong> email & password from Shiprocket → Settings → API. Credentials are saved securely on your device for auto-login next time.</span></div>
          <label style={Z.label}>API User Email</label><input style={Z.input} type="email" placeholder="api-user@company.com" value={email} onChange={e => setEmail(e.target.value)} />
          <label style={Z.label}>Password</label><input style={Z.input} type="password" placeholder="••••••••" value={pw} onChange={e => setPw(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} />
          <button style={{ ...Z.btn, ...(loading ? { opacity: .6 } : {}) }} onClick={handleLogin} disabled={loading}>{loading ? "Connecting..." : "Connect & Fetch Orders"}</button>
          <div style={{ marginTop: 10, fontSize: 11, color: "#4a7a7a" }}>⚠️ If CORS blocks the API in this browser, use CSV upload instead. Works perfectly when run locally.</div>
        </>)}
        {mode === "csv" && (<>
          {corsMsg && <div style={{ padding: "12px 16px", background: "#fbbf2412", border: "1px solid #fbbf2433", borderRadius: 10, marginBottom: 14, fontSize: 13, color: "#fbbf24", lineHeight: 1.5 }}>⚠️ {corsMsg}</div>}
          <div style={Z.hint}><span style={{ fontSize: 15 }}>💡</span><span>Go to <strong style={{ color: "#cbd5e1" }}>Shiprocket → Orders → Export</strong> → Download CSV → Upload here</span></div>
          <div style={{ ...Z.drop, ...(drag ? Z.dropActive : {}) }}
            onDragOver={e => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={e => { e.preventDefault(); setDrag(false); handleCSV(e.dataTransfer.files[0]); }}
            onClick={() => fileRef.current?.click()}>
            <input ref={fileRef} type="file" accept=".csv" style={{ display: "none" }} onChange={e => handleCSV(e.target.files[0])} />
            <div style={{ fontSize: 36, marginBottom: 6 }}>📁</div>
            <div style={{ color: "#e2e8f0", fontWeight: 600, fontSize: 14 }}>{loading ? "Processing..." : "Drop CSV here"}</div>
            <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>or click to browse</div>
          </div>
        </>)}
      </div>
    </div>
  );
}

// ===================== DASHBOARD =====================
function Dashboard({ allOrders, source, onLogout }) {
  const [tab, setTab] = useState("overview");
  const [filter, setFilter] = useState("");
  const [costs, setCosts] = useState({});
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Load costs on mount
  useEffect(() => { loadCosts().then(setCosts); }, []);

  // Filter by date
  const orders = useMemo(() => {
    if (!dateFrom && !dateTo) return allOrders;
    const from = dateFrom ? new Date(dateFrom + "T00:00:00") : null;
    const to = dateTo ? new Date(dateTo + "T23:59:59") : null;
    return allOrders.filter(o => {
      if (!o.dateObj || isNaN(o.dateObj.getTime())) return true;
      if (from && o.dateObj < from) return false;
      if (to && o.dateObj > to) return false;
      return true;
    });
  }, [allOrders, dateFrom, dateTo]);

  const a = useAnalytics(orders);
  const srcB = { csv: { bg: "#60a5fa18", c: "#60a5fa", t: "CSV" }, api: { bg: "#34d39918", c: "#34d399", t: "● LIVE" } }[source] || { bg: "#94a3b818", c: "#94a3b8", t: "DATA" };
  const nt = (id, lbl) => (<button key={id} onClick={() => setTab(id)} style={{ padding: "8px 16px", background: tab === id ? "#134e4a" : "transparent", border: "none", borderRadius: 8, color: tab === id ? "#5eead4" : "#64748b", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>{lbl}</button>);

  const handleLogout = async () => { await saveToken(null); onLogout(); };
  const [, forceUpdate] = useState(0);
  const applyDate = () => forceUpdate(x => x + 1);

  return (
    <div style={Z.dashWrap}>
      <div style={Z.topBar}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo s={28} /><div><span style={{ fontSize: 15, fontWeight: 800, color: "#f0fdfa" }}>Analytics Dashboard</span> <span style={{ fontSize: 10, fontWeight: 600, color: "#5eead4", letterSpacing: "1.5px" }}>ADSMIT</span></div>
          <span style={{ background: srcB.bg, color: srcB.c, fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 6 }}>{srcB.t}</span>
        </div>
        <button style={Z.backBtn} onClick={handleLogout}>Logout</button>
      </div>

      <DateFilter dateFrom={dateFrom} dateTo={dateTo} setDateFrom={setDateFrom} setDateTo={setDateTo} onApply={applyDate} totalInRange={orders.length} totalAll={allOrders.length} />

      <div style={{ display: "flex", gap: 4, padding: "10px 28px", overflowX: "auto", background: "#091212" }}>
        {nt("overview", "Overview")}{nt("ndr", `NDR (${a.groups.NDR})`)}{nt("rto", `RTO (${a.groups.RTO})`)}{nt("sku", "SKU Table")}{nt("profit", "💰 Net Profit")}{nt("pincode", "📍 Pincodes")}{nt("groups", "🏷️ Groups")}{nt("breakeven", "🧮 Breakeven")}{nt("costs", "⚙️ Cost Manager")}
      </div>

      <div style={{ padding: "0 28px 40px" }}>
        {tab === "overview" && (<>
          <div style={Z.kpiRow}>
            <KPI label="Total Orders" value={a.total.toLocaleString()} sub={`${a.skuStats.length} SKUs`} />
            <KPI label="Shipped" value={a.shipped.toLocaleString()} color="#5eead4" sub={`${((a.shipped / a.total) * 100).toFixed(0)}% of total`} sub2="Excl. new, cancelled, pickup" />
            <KPI label="Del % (shipped)" value={`${a.delPct}%`} sub={`${a.groups.DELIVERED} delivered`} color="#34d399" />
            <KPI label="NDR %" value={`${a.ndrPct}%`} sub={`${a.groups.NDR} undelivered`} color="#fbbf24" />
            <KPI label="RTO %" value={`${a.rtoPct}%`} sub={`${a.groups.RTO} returned`} color="#f87171" />
            <KPI label="Cancelled" value={a.groups.CANCELLED} color="#6b7280" />
          </div>
          <div style={Z.card}><div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}><h3 style={Z.secTitle}>Status distribution</h3><div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>{GROUP_ORDER.map(g => a.groups[g] > 0 && <span key={g} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#94a3b8" }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: SG[g].c }} />{SG[g].label} ({a.groups[g]})</span>)}</div></div><GroupBar groups={a.groups} total={a.total} /></div>
          <div style={Z.card}><h3 style={Z.secTitle}>Top SKUs</h3><div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>{a.skuStats.filter(r => r.shipped > 0).slice(0, 8).map(row => { const mx = a.skuStats[0]?.shipped || 1; return (<div key={row.sku} style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ width: 140, fontSize: 11, color: "#94a3b8", fontWeight: 600, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flexShrink: 0 }}>{row.sku}</div><div style={{ flex: 1, display: "flex", height: 18, borderRadius: 4, overflow: "hidden", background: "#0c1a1a" }}><div style={{ height: "100%", width: `${(row.DELIVERED / mx) * 100}%`, background: "#34d399" }} /><div style={{ height: "100%", width: `${(row.NDR / mx) * 100}%`, background: "#fbbf24" }} /><div style={{ height: "100%", width: `${(row.RTO / mx) * 100}%`, background: "#f87171" }} /><div style={{ height: "100%", width: `${((row.shipped - row.DELIVERED - row.NDR - row.RTO) / mx) * 100}%`, background: "#1e3a3a" }} /></div><div style={{ width: 40, fontSize: 11, color: "#64748b", textAlign: "right" }}>{row.shipped}</div></div>); })}</div></div>
          <div style={{ display: "flex", gap: 16, marginTop: 16, flexWrap: "wrap" }}>
            <div style={{ ...Z.card, flex: "1 1 300px" }}><h3 style={Z.secTitle}>NDR + RTO by courier</h3><div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>{a.sortedCourier.map(([c, v]) => (<div key={c} style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ flex: 1, fontSize: 12, color: "#cbd5e1", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c}</div><span style={{ ...Z.badge, background: "#fbbf2418", color: "#fbbf24", fontSize: 11 }}>{v.NDR}</span><span style={{ ...Z.badge, background: "#f8717118", color: "#f87171", fontSize: 11 }}>{v.RTO}</span></div>))}</div></div>
            <div style={{ ...Z.card, flex: "1 1 300px" }}><h3 style={Z.secTitle}>NDR + RTO by state</h3><div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>{a.sortedState.map(([s, v]) => (<div key={s} style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ flex: 1, fontSize: 12, color: "#cbd5e1" }}>{s}</div><span style={{ ...Z.badge, background: "#fbbf2418", color: "#fbbf24", fontSize: 11 }}>{v.NDR}</span><span style={{ ...Z.badge, background: "#f8717118", color: "#f87171", fontSize: 11 }}>{v.RTO}</span></div>))}</div></div>
          </div>
        </>)}
        {tab === "ndr" && (<>
          <div style={Z.kpiRow}><KPI label="Total NDR" value={a.groups.NDR} sub={`${a.ndrPct}% of shipped`} color="#fbbf24" /><KPI label="NDR + RTO" value={a.groups.NDR + a.groups.RTO} color="#f87171" /><KPI label="Shipped" value={a.shipped} color="#5eead4" /></div>
          <div style={Z.card}><h3 style={Z.secTitle}>NDR sub-statuses</h3><div style={{ marginTop: 12 }}><Pills items={a.sortedNdrSub} color="#fbbf24" /></div></div>
          <div style={Z.card}><h3 style={Z.secTitle}>NDR reasons</h3><div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>{a.sortedNdrR.map(([r, c]) => (<div key={r} style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ flex: 1, height: 22, borderRadius: 4, background: "#0c1a1a" }}><div style={{ height: "100%", width: `${(c / (a.sortedNdrR[0]?.[1] || 1)) * 100}%`, background: "#fbbf24", borderRadius: 4, opacity: .3 }} /></div><div style={{ width: 180, fontSize: 12, color: "#cbd5e1", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r}</div><div style={{ width: 36, fontSize: 13, fontWeight: 700, color: "#fbbf24", textAlign: "right" }}>{c}</div></div>))}</div></div>
        </>)}
        {tab === "rto" && (<>
          <div style={Z.kpiRow}><KPI label="Total RTO" value={a.groups.RTO} sub={`${a.rtoPct}% of shipped`} color="#f87171" /><KPI label="NDR + RTO" value={a.groups.NDR + a.groups.RTO} color="#fbbf24" /><KPI label="Shipped" value={a.shipped} color="#5eead4" /></div>
          <div style={Z.card}><h3 style={Z.secTitle}>RTO sub-statuses</h3><div style={{ marginTop: 12 }}><Pills items={a.sortedRtoSub} color="#f87171" /></div></div>
          <div style={Z.card}><h3 style={Z.secTitle}>RTO reasons</h3><div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>{a.sortedRtoR.map(([r, c]) => (<div key={r} style={{ display: "flex", alignItems: "center", gap: 10 }}><div style={{ flex: 1, height: 22, borderRadius: 4, background: "#0c1a1a" }}><div style={{ height: "100%", width: `${(c / (a.sortedRtoR[0]?.[1] || 1)) * 100}%`, background: "#f87171", borderRadius: 4, opacity: .3 }} /></div><div style={{ width: 180, fontSize: 12, color: "#cbd5e1", textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r}</div><div style={{ width: 36, fontSize: 13, fontWeight: 700, color: "#f87171", textAlign: "right" }}>{c}</div></div>))}</div></div>
        </>)}
        {tab === "sku" && <div style={{ marginTop: 20 }}><SkuTable data={a.skuStats} filter={filter} setFilter={setFilter} costs={costs} /></div>}
        {tab === "profit" && <NetProfit skuStats={a.skuStats} costs={costs} />}
        {tab === "pincode" && <PincodeRTO orders={orders} />}
        {tab === "groups" && <ProductGroups skuStats={a.skuStats} orders={orders} costs={costs} />}
        {tab === "breakeven" && <Breakeven skuStats={a.skuStats} costs={costs} />}
        {tab === "costs" && <CostManager skuList={a.skuStats.map(s => s.sku)} costs={costs} setCosts={setCosts} skuStats={a.skuStats} />}
      </div>
    </div>
  );
}

// ===================== APP =====================
export default function App() {
  const [screen, setScreen] = useState("login");
  const [orders, setOrders] = useState([]);
  const [source, setSource] = useState("csv");

  return screen === "login" ? (
    <LoginScreen
      onData={(o, s) => { setOrders(o); setSource(s); setScreen("dash"); }}
      onCSV={(o) => { setOrders(o); setSource("csv"); setScreen("dash"); }}
    />
  ) : (
    <Dashboard allOrders={orders} source={source} onLogout={() => { setOrders([]); setScreen("login"); }} />
  );
}

// ===================== STYLES =====================
const Z = {
  loginWrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(160deg,#040d0d 0%,#0a1a1a 40%,#091515 100%)", fontFamily: "'Outfit','Segoe UI',system-ui,sans-serif", padding: 20 },
  loginCard: { background: "linear-gradient(165deg,#0f2626 0%,#0a1e1e 100%)", border: "1px solid #1a3a3a", borderRadius: 20, padding: "36px 34px", maxWidth: 480, width: "100%", boxShadow: "0 30px 70px rgba(0,0,0,.6)" },
  hint: { display: "flex", gap: 10, alignItems: "flex-start", background: "#0c1a1a", border: "1px solid #1a3a3a", borderRadius: 10, padding: "11px 14px", marginBottom: 16, fontSize: 12, color: "#94a3b8", lineHeight: 1.6 },
  label: { display: "block", color: "#64748b", fontSize: 10, fontWeight: 700, marginBottom: 5, marginTop: 14, textTransform: "uppercase", letterSpacing: ".7px" },
  input: { width: "100%", padding: "11px 14px", background: "#040d0d", border: "1px solid #1a3a3a", borderRadius: 10, color: "#e2e8f0", fontSize: 14, outline: "none", boxSizing: "border-box" },
  btn: { width: "100%", padding: "13px 0", background: "linear-gradient(135deg,#0d9488,#0f766e)", color: "#fff", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 700, cursor: "pointer", marginTop: 20 },
  err: { background: "#f8717118", border: "1px solid #f8717144", color: "#fca5a5", padding: "10px 14px", borderRadius: 10, fontSize: 13, marginBottom: 12 },
  drop: { border: "2px dashed #1a3a3a", borderRadius: 14, padding: "30px 20px", textAlign: "center", cursor: "pointer", background: "#040d0d44" },
  dropActive: { borderColor: "#0d9488", background: "#0d948811" },
  loadWrap: { minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#040d0d", fontFamily: "'Outfit','Segoe UI',system-ui,sans-serif" },
  dashWrap: { minHeight: "100vh", background: "linear-gradient(180deg,#040d0d 0%,#091515 100%)", fontFamily: "'Outfit','Segoe UI',system-ui,sans-serif", color: "#e2e8f0" },
  topBar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 28px", background: "#040d0dee", borderBottom: "1px solid #1a2e2e", position: "sticky", top: 0, zIndex: 10, backdropFilter: "blur(14px)" },
  backBtn: { background: "transparent", border: "1px solid #1a3a3a", color: "#64748b", padding: "6px 14px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontWeight: 600 },
  kpiRow: { display: "flex", gap: 12, paddingTop: 18, flexWrap: "wrap" },
  kpi: { flex: "1 1 130px", background: "linear-gradient(165deg,#0f2626,#0a1e1e)", border: "1px solid #1a3a3a33", borderRadius: 14, padding: "16px 18px" },
  kpiLabel: { color: "#4a7a7a", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".8px", marginBottom: 5 },
  card: { background: "#0a1e1e88", border: "1px solid #1a3a3a33", borderRadius: 14, padding: "16px 18px", marginTop: 14 },
  secTitle: { color: "#d1fae5", fontSize: 14, fontWeight: 700, margin: 0 },
  search: { background: "#040d0d", border: "1px solid #1a3a3a", borderRadius: 8, padding: "7px 12px", color: "#e2e8f0", fontSize: 12, outline: "none", width: 180 },
  th: { textAlign: "left", padding: "9px 10px", fontSize: 10, fontWeight: 700, color: "#4a7a7a", textTransform: "uppercase", letterSpacing: ".7px", borderBottom: "1px solid #1a3a3a", whiteSpace: "nowrap" },
  td: { padding: "9px 10px", fontSize: 12, color: "#cbd5e1", whiteSpace: "nowrap" },
  tdSku: { padding: "9px 10px", fontSize: 12, color: "#e2e8f0", fontWeight: 700, fontFamily: "'JetBrains Mono','Fira Code',monospace", letterSpacing: "-.3px", whiteSpace: "nowrap" },
  badge: { display: "inline-block", padding: "3px 10px", borderRadius: 6, fontSize: 12, fontWeight: 700 },
};

if (typeof document !== "undefined") {
  const st = document.createElement("style");
  st.textContent = `@keyframes spin{to{transform:rotate(360deg)}}@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap');*{box-sizing:border-box;margin:0}input:focus,textarea:focus,select:focus{border-color:#0d9488!important;outline:none}button:hover{opacity:.88}tr:hover{background:#0d94880a}select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%235eead4' d='M2 4l4 4 4-4'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center}select option{background:#0a1e1e;color:#e2e8f0}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#1a3a3a;border-radius:3px}input[type="date"]::-webkit-calendar-picker-indicator{filter:invert(0.7)}`;
  document.head.appendChild(st);
}
