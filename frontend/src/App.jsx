import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000/api";

// ─── API helpers ─────────────────────────────────────────────────────────────
const getToken = () => localStorage.getItem("token");
const api = async (method, path, body) => {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Request failed");
  }
  return res.status === 204 ? null : res.json();
};

// ─── Auth Context ─────────────────────────────────────────────────────────────
function useAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (getToken()) {
      api("GET", "/auth/me")
        .then(setUser)
        .catch(() => localStorage.removeItem("token"))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email, password) => {
    const form = new FormData();
    form.append("username", email);
    form.append("password", password);
    const res = await fetch(`${API}/auth/login`, { method: "POST", body: form });
    if (!res.ok) throw new Error("Invalid credentials");
    const data = await res.json();
    localStorage.setItem("token", data.access_token);
    setUser(data.user);
  };

  const logout = () => {
    localStorage.removeItem("token");
    setUser(null);
  };

  return { user, loading, login, logout };
}

// ─── Components ──────────────────────────────────────────────────────────────

function Badge({ children, color = "gray" }) {
  const colors = {
    gray: "bg-slate-100 text-slate-700 border border-slate-200/50",
    green: "bg-emerald-50 text-emerald-700 border border-emerald-100",
    blue: "bg-sky-50 text-sky-700 border border-sky-100",
    yellow: "bg-amber-50 text-amber-700 border border-amber-100",
    red: "bg-rose-50 text-rose-700 border border-rose-100",
    purple: "bg-indigo-50 text-indigo-700 border border-indigo-100",
  };
  return (
    <span className={`px-2 py-0.5 rounded-md text-xs font-semibold tracking-wide ${colors[color] || colors.gray}`}>
      {children}
    </span>
  );
}

// Find and replace the entire StatusBadge component:
function StatusBadge({ status }) {
  const map = {
    // Basic
    ACTIVE: ["green", "Active"],
    PAUSED: ["yellow", "Paused"],
    DRAFT: ["gray", "Draft"],
    COMPLETED: ["blue", "Completed"],
    NEW: ["gray", "New"],
    CONTACTED: ["blue", "Contacted"],
    REPLIED: ["purple", "Replied"],
    BOUNCED: ["red", "Bounced"],
    UNSUBSCRIBED: ["red", "Unsub'd"],
    OPTED_OUT: ["red", "Opted Out"],
    // Qualified
    INTERESTED: ["green", "✓ Interested"],
    MEETING_BOOKED: ["green", "📅 Meeting"],
    // Disqualified
    NOT_INTERESTED: ["red", "✗ Not Interested"],
    WRONG_PERSON: ["red", "✗ Wrong Person"],
    DO_NOT_CONTACT: ["red", "🚫 DNC"],
    // Temp
    OUT_OF_OFFICE: ["yellow", "🏖 OOO"],
  };
  const [color, label] = map[status] || ["gray", status];
  return <Badge color={color}>{label}</Badge>;
}

function Card({ children, className = "", onClick, ...rest }) {
  return (
    <div
      className={`bg-white rounded-xl border border-slate-100 shadow-sm transition-all duration-200 hover:border-slate-200/80 ${onClick ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5' : ''} ${className}`}
      onClick={onClick}
      {...rest}
    >
      {children}
    </div>
  );
}

function Button({ children, onClick, variant = "primary", size = "md", disabled, type = "button", className = "" }) {
  const base = "inline-flex items-center justify-center gap-2 font-semibold rounded-lg transition-all duration-150 active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none disabled:active:scale-100";
  const sizes = {
    sm: "px-3 py-1.5 text-xs",
    md: "px-4 py-2 text-sm",
    lg: "px-5 py-2.5 text-sm"
  };
  const variants = {
    primary: "bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm shadow-indigo-100 hover:shadow-indigo-200",
    secondary: "bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 hover:text-slate-900 shadow-sm",
    danger: "bg-rose-600 hover:bg-rose-500 text-white shadow-sm shadow-rose-100",
    ghost: "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

function Input({ label, error, ...props }) {
  return (
    <div className="flex flex-col gap-1 w-full">
      {label && <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{label}</label>}
      <input
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500 transition-all placeholder:text-slate-400"
        {...props}
      />
      {error && <p className="text-xs text-rose-600 font-medium">{error}</p>}
    </div>
  );
}

function Textarea({ label, ...props }) {
  return (
    <div className="flex flex-col gap-1 w-full">
      {label && <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">{label}</label>}
      <textarea
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500 transition-all placeholder:text-slate-400 min-h-[120px] resize-y"
        {...props}
      />
    </div>
  );
}

// ─── Login Page ───────────────────────────────────────────────────────────────
function LoginPage({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [isRegister, setIsRegister] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      if (isRegister) {
        await api("POST", "/auth/register", { email, password });
      }
      await onLogin(email, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center relative overflow-hidden px-4">
      {/* Dynamic glow design background */}
      <div className="absolute top-[-20%] left-[-20%] w-[60%] h-[60%] bg-indigo-500/10 rounded-full blur-[120px]" />
      <div className="absolute bottom-[-20%] right-[-20%] w-[60%] h-[60%] bg-sky-500/10 rounded-full blur-[120px]" />

      <div className="w-full max-w-[380px] z-10 animate-fade-in">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-tr from-indigo-600 to-indigo-400 text-white font-bold text-xl shadow-lg shadow-indigo-500/20 mb-3">
            CR
          </div>
          <h1 className="text-3xl font-extrabold text-white tracking-tight">ColdReach</h1>
          <p className="text-slate-400 text-sm mt-1">Cold email campaign management platform</p>
        </div>

        <div className="bg-slate-800/80 border border-slate-700/50 backdrop-blur-md rounded-2xl p-6 shadow-2xl">
          <h2 className="text-xl font-bold text-white mb-4">{isRegister ? "Create account" : "Sign in to account"}</h2>
          {error && <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs p-3 rounded-lg mb-4 font-medium">{error}</div>}

          <form onSubmit={submit} className="flex flex-col gap-4">
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block">Email Address</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="you@company.com"
                className="w-full border border-slate-700 rounded-lg px-3 py-2 text-sm bg-slate-900 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
              />
            </div>
            <div>
              <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1 block">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="w-full border border-slate-700 rounded-lg px-3 py-2 text-sm bg-slate-900 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 transition-all"
              />
            </div>

            <Button type="submit" disabled={loading} className="w-full mt-2">
              {loading ? "Loading..." : isRegister ? "Create account" : "Sign In"}
            </Button>
          </form>

          <p className="text-xs text-center text-slate-400 mt-5">
            {isRegister ? "Already have an account?" : "Don't have an account yet?"}{" "}
            <button className="text-indigo-400 font-semibold hover:text-indigo-300 ml-1 transition-colors" onClick={() => setIsRegister(!isRegister)}>
              {isRegister ? "Sign in" : "Register"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Campaign List ────────────────────────────────────────────────────────────
function CampaignList({ onSelect, onNew }) {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await api("GET", "/campaigns");
      setCampaigns(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleStatus = async (c) => {
    const newStatus = c.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    try {
      await api("PATCH", `/campaigns/${c.id}`, { status: newStatus });
      load();
    } catch (err) {
      alert(err.message);
    }
  };

  const handleExportCampaign = async (c) => {
    try {
      const data = await api("GET", `/campaigns/${c.id}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_campaign_export.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Failed to export campaign: " + err.message);
    }
  };

  const handleImportCampaign = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const payload = JSON.parse(evt.target.result);
        if (!payload.settings || !payload.sequences) {
          throw new Error("Invalid campaign export file format. Missing settings or sequences.");
        }
        const campaign = await api("POST", "/campaigns/import", payload);
        load();
        onSelect(campaign);
      } catch (err) {
        alert("Failed to import campaign: " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = null;
  };

  if (loading) return <div className="p-8 text-slate-500 font-semibold">Loading campaigns...</div>;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Outreach Campaigns</h2>
          <p className="text-slate-500 text-xs mt-1">Manage and track your email marketing sequences</p>
        </div>
        <div className="flex gap-2">
          <input
            type="file"
            id="import-campaign-file"
            accept=".json"
            className="hidden"
            onChange={handleImportCampaign}
          />
          <Button variant="secondary" onClick={() => document.getElementById("import-campaign-file").click()}>
            <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
            Import JSON
          </Button>
          <Button onClick={onNew}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            New Campaign
          </Button>
        </div>
      </div>

      {campaigns.length === 0 ? (
        <Card className="p-16 text-center border-dashed border-2 flex flex-col items-center justify-center">
          <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400 mb-3">
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
          </div>
          <h3 className="text-base font-bold text-slate-800">No campaigns yet</h3>
          <p className="text-slate-500 text-xs max-w-sm mt-1 mb-5">Create your first cold email outreach campaign to start generating leads.</p>
          <Button size="sm" onClick={onNew}>Create First Campaign</Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {campaigns.map(c => {
            const trackingDisabled = !c.track_open_rate || !c.track_reply_rate;
            return (
              <Card key={c.id} className="p-5 hover:shadow-md transition-all cursor-pointer border-t-4 border-t-indigo-600 flex flex-col justify-between" onClick={() => onSelect(c)}>
                <div>
                  <div className="flex items-start justify-between mb-4 gap-2">
                    <div className="flex flex-col gap-1.5 min-w-0">
                      <span className="font-bold text-slate-900 text-base truncate" title={c.name}>{c.name}</span>
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={c.status} />
                        {trackingDisabled && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 border border-amber-100" title="Email tracking is disabled for maximum deliverability">
                            🔒 Deliverability Max
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={e => { e.stopPropagation(); toggleStatus(c); }}
                      >
                        {c.status === "ACTIVE" ? "⏸ Pause" : "▶ Activate"}
                      </Button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          handleExportCampaign(c);
                        }}
                        className="p-2 rounded-lg border border-slate-200 text-slate-400 hover:text-indigo-600 hover:border-indigo-100 hover:bg-indigo-50 transition-all active:scale-[0.98]"
                        title="Export campaign configuration (JSON)"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                        </svg>
                      </button>
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (confirm(`Are you sure you want to permanently delete the campaign "${c.name}"? This will delete all sequences, leads, history logs, and scheduled emails. This action is irreversible.`)) {
                            await api("DELETE", `/campaigns/${c.id}`);
                            load();
                          }
                        }}
                        className="p-2 rounded-lg border border-slate-200 text-slate-400 hover:text-rose-600 hover:border-rose-100 hover:bg-rose-50 transition-all active:scale-[0.98]"
                        title="Delete campaign"
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center py-3 bg-slate-50/80 rounded-xl border border-slate-100/50 mb-4">
                    <div>
                      <p className="text-base font-extrabold text-slate-800">{c.lead_count ?? 0}</p>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Leads</p>
                    </div>
                    <div>
                      <p className="text-base font-extrabold text-indigo-600">{c.sent_count ?? 0}</p>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Sent</p>
                    </div>
                    <div>
                      <p className="text-base font-extrabold text-emerald-600">{c.reply_count ?? 0}</p>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Replies</p>
                    </div>
                  </div>
                </div>

                <div className="text-xs text-slate-500 space-y-1.5 border-t border-slate-100 pt-3 flex flex-col justify-end">
                  <div className="flex justify-between font-medium">
                    <span className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      {c.sending_window_start}–{c.sending_window_end}
                    </span>
                    <span className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5" /></svg>
                      {c.timezone}
                    </span>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NewCampaignForm({ onCreated, onCancel }) {
  const [form, setForm] = useState({
    name: "",
    daily_email_limit: 50,
    daily_new_leads: 20,
    followup_percentage: 0.7,
    sending_window_start: "09:00",
    sending_window_end: "17:00",
    timezone: "Asia/Kolkata", // Default to IST
    active_days: {
      monday: true, tuesday: true, wednesday: true,
      thursday: true, friday: true, saturday: false, sunday: false,
    },
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [step, setStep] = useState(0); // 0=basics, 1=limits, 2=schedule

  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const followupPct = Math.round(form.followup_percentage * 100);

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const campaign = await api("POST", "/campaigns", form);
      onCreated(campaign);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const steps = [
    { label: "Basics", icon: "✦" },
    { label: "Limits", icon: "⟆" },
    { label: "Schedule", icon: "◷" },
  ];

  return (
    <div className="max-w-[580px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <button onClick={onCancel} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-slate-600 transition-colors bg-none border-none cursor-pointer mb-4">
          <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          Back to campaigns
        </button>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Create New Campaign</h1>
        <p className="text-slate-500 text-xs mt-1">Configure sending guidelines and parameters for outreach</p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center justify-between mb-6 bg-white border border-slate-100/80 p-3 rounded-xl shadow-sm">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center flex-1 last:flex-none">
            <button
              type="button"
              onClick={() => setStep(i)}
              className="flex items-center gap-2 cursor-pointer outline-none focus:outline-none"
            >
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold transition-all ${i === step
                ? "bg-indigo-600 text-white shadow-sm shadow-indigo-100"
                : i < step
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
                  : "bg-slate-50 text-slate-400 border border-slate-200/50"
                }`}>
                {i < step ? "✓" : i + 1}
              </div>
              <span className={`text-xs font-semibold ${i === step ? "text-slate-900" : "text-slate-400"}`}>{s.label}</span>
            </button>
            {i < steps.length - 1 && (
              <div className={`flex-1 h-0.5 mx-3 transition-colors ${i < step ? "bg-emerald-200" : "bg-slate-100"}`} />
            )}
          </div>
        ))}
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs p-3.5 rounded-xl mb-4 font-semibold">
          ✗ {error}
        </div>
      )}

      <form onSubmit={submit} className="space-y-4">
        {/* Step 0: Basics */}
        {step === 0 && (
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-100 flex items-center justify-center">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.2"><path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-800">Campaign Details</h3>
                <p className="text-[11px] text-slate-400">Give your campaign a memorable name</p>
              </div>
            </div>

            <div className="mb-6">
              <Input
                label="Campaign Name"
                placeholder="e.g. Q1 SaaS Founders Outreach"
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                required
                autoFocus
              />
            </div>

            <div className="border-t border-slate-100 my-5 pt-5">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Or Import from Campaign JSON</label>
              <div className="flex items-center gap-3">
                <input
                  type="file"
                  id="import-campaign-form-file"
                  accept=".json"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async (evt) => {
                      try {
                        const payload = JSON.parse(evt.target.result);
                        if (!payload.settings || !payload.sequences) {
                          throw new Error("Invalid campaign export file format.");
                        }
                        setLoading(true);
                        const campaign = await api("POST", "/campaigns/import", payload);
                        onCreated(campaign);
                      } catch (err) {
                        alert("Failed to import campaign: " + err.message);
                      } finally {
                        setLoading(false);
                      }
                    };
                    reader.readAsText(file);
                    e.target.value = null;
                  }}
                />
                <Button 
                  type="button" 
                  variant="secondary" 
                  className="w-full flex justify-center py-4 border-dashed border-2 border-slate-200 hover:border-indigo-400 hover:bg-indigo-50/10 text-slate-600 transition-all font-semibold"
                  onClick={() => document.getElementById("import-campaign-form-file").click()}
                >
                  <svg className="w-5 h-5 mr-2 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                  Choose Campaign JSON File
                </Button>
              </div>
            </div>

            <div className="flex justify-end border-t border-slate-100 pt-4">
              <Button type="button" onClick={() => setStep(1)} className="px-5">
                Next: Limits
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              </Button>
            </div>
          </Card>
        )}

        {/* Step 1: Limits */}
        {step === 1 && (
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg bg-sky-50 text-sky-700 border border-sky-100 flex items-center justify-center">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.2"><path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-800">Sending Constraints</h3>
                <p className="text-[11px] text-slate-400">Control daily sending limits and rates</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-6">
              <div>
                <Input
                  label="Daily email limit"
                  type="number"
                  min={1}
                  max={500}
                  value={form.daily_email_limit}
                  onChange={e => setForm({ ...form, daily_email_limit: +e.target.value })}
                />
                <p className="text-[10px] text-slate-400 mt-1 font-semibold">Total emails sent per day max</p>
              </div>
              <div>
                <Input
                  label="New leads / day"
                  type="number"
                  min={1}
                  value={form.daily_new_leads}
                  onChange={e => setForm({ ...form, daily_new_leads: +e.target.value })}
                />
                <p className="text-[10px] text-slate-400 mt-1 font-semibold">Fresh touchpoints per day</p>
              </div>
            </div>

            {/* Follow-up slider */}
            <div className="bg-slate-50 border border-slate-100 p-4 rounded-xl mb-6">
              <div className="flex justify-between items-center mb-3">
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Follow-up / New Ratio</label>
                <span className="text-xs font-bold text-slate-800 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-md">{followupPct}% / {100 - followupPct}%</span>
              </div>
              <input
                type="range" min={0} max={100}
                value={followupPct}
                onChange={e => setForm({ ...form, followup_percentage: +e.target.value / 100 })}
                className="w-full accent-indigo-600 cursor-pointer h-1 bg-slate-200 rounded-lg appearance-none"
              />
              <div className="flex justify-between mt-3 text-[10px] text-slate-400 font-bold uppercase tracking-wide">
                <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-indigo-600" />{followupPct}% follow-ups</span>
                <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-slate-400" />{100 - followupPct}% new leads</span>
              </div>
            </div>

            <div className="flex justify-between border-t border-slate-100 pt-4">
              <Button type="button" variant="secondary" onClick={() => setStep(0)}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                Back
              </Button>
              <Button type="button" onClick={() => setStep(2)}>
                Next: Schedule
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
              </Button>
            </div>
          </Card>
        )}

        {/* Step 2: Schedule */}
        {step === 2 && (
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-100 flex items-center justify-center">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.2"><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              </div>
              <div>
                <h3 className="text-sm font-bold text-slate-800">Sending Calendar</h3>
                <p className="text-[11px] text-slate-400">Configure timezone, times and active days</p>
              </div>
            </div>

            {/* Time window */}
            <div className="grid grid-cols-2 gap-4 mb-5">
              <div>
                <Input label="Window Start (IST)" type="time" value={form.sending_window_start} onChange={e => setForm({ ...form, sending_window_start: e.target.value })} />
              </div>
              <div>
                <Input label="Window End (IST)" type="time" value={form.sending_window_end} onChange={e => setForm({ ...form, sending_window_end: e.target.value })} />
              </div>
            </div>

            {/* Visual time bar */}
            {(() => {
              const toMins = t => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
              const startPct = (toMins(form.sending_window_start) / 1440) * 100;
              const endPct = (toMins(form.sending_window_end) / 1440) * 100;
              return (
                <div className="mb-5 bg-slate-50 border border-slate-100 p-4 rounded-xl">
                  <div className="flex justify-between mb-2 text-[9px] text-slate-400 font-bold uppercase tracking-wider">
                    <span>12 AM</span>
                    <span>6 AM</span>
                    <span>12 PM</span>
                    <span>6 PM</span>
                    <span>12 AM</span>
                  </div>
                  <div className="height-2 bg-slate-200 rounded-full overflow-hidden relative h-2">
                    <div className="absolute bg-indigo-600 rounded-full h-full" style={{ left: `${startPct}%`, width: `${Math.max(endPct - startPct, 0)}%` }} />
                  </div>
                  <p className="text-[11px] text-slate-500 font-semibold mt-3 text-center">
                    Emails spaced evenly between <strong className="text-slate-800">{form.sending_window_start}</strong> and <strong className="text-slate-800">{form.sending_window_end}</strong> IST
                  </p>
                </div>
              );
            })()}

            {/* Active days */}
            <div className="mb-6">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Active days</label>
              <div className="flex gap-2">
                {days.map(d => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setForm({ ...form, active_days: { ...form.active_days, [d]: !form.active_days[d] } })}
                    className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all border ${form.active_days[d]
                      ? "bg-slate-900 text-white border-slate-900 shadow-sm"
                      : "bg-white text-slate-400 border-slate-200 hover:bg-slate-50"
                      }`}
                  >
                    {d.slice(0, 1).toUpperCase() + d.slice(1, 2)}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-between border-t border-slate-100 pt-4">
              <Button type="button" variant="secondary" onClick={() => setStep(1)}>
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                Back
              </Button>
              <Button
                type="submit"
                disabled={loading}
                className="px-6"
              >
                {loading ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Creating…
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    Create Campaign
                  </>
                )}
              </Button>
            </div>
          </Card>
        )}
      </form>
    </div>
  );
}

// ─── Variable Autocomplete Textarea ──────────────────────────────────────────
function VarTextarea({ value, onChange, availableFields, placeholder, rows = 6, label, isPlainText = true }) {
  const [suggestion, setSuggestion] = useState(null); // {fields, pos, query}
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [ta, setTa] = useState(null);
  const editorRef = useRef(null);

  // Sync outer value updates to rich text editor innerHTML only if different
  useEffect(() => {
    if (!isPlainText && editorRef.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value || "";
    }
  }, [value, isPlainText]);

  const handleInput = () => {
    if (editorRef.current) {
      let html = editorRef.current.innerHTML;
      if (html === "<br>" || html === "<div><br></div>" || html === "<p><br></p>" || html.trim() === "") {
        html = "";
      }
      onChange(html);
    }
  };

  const handleToolbarClick = (e, command, arg = null) => {
    e.preventDefault();
    if (editorRef.current) {
      editorRef.current.focus();
    }
    if (command === "createLink") {
      const url = prompt("Enter URL:", "https://");
      if (url) {
        document.execCommand("createLink", false, url);
      }
    } else {
      document.execCommand(command, false, arg);
    }
    handleInput();
  };

  const insertVariable = (field) => {
    if (isPlainText) {
      if (!ta) return;
      const val = ta.value;
      const pos = ta.selectionStart;
      const insert = `{{${field}}}`;
      const newVal = val.slice(0, pos) + insert + val.slice(pos);
      onChange(newVal);
      setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(pos + insert.length, pos + insert.length);
      }, 0);
    } else {
      if (!editorRef.current) return;
      editorRef.current.focus();
      const varText = `{{${field}}}`;
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (editorRef.current.contains(range.commonAncestorContainer)) {
          range.deleteContents();
          const textNode = document.createTextNode(varText);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.setEndAfter(textNode);
          sel.removeAllRanges();
          sel.addRange(range);
          handleInput();
          return;
        }
      }
      editorRef.current.innerHTML += varText;
      handleInput();
    }
  };

  const handleChange = (e) => {
    const val = e.target.value;
    onChange(val);

    // Detect {{ trigger
    const cursor = e.target.selectionStart;
    const textBefore = val.slice(0, cursor);
    const match = textBefore.match(/\{\{([a-zA-Z0-9_]*)$/);
    if (match) {
      const query = match[1].toLowerCase();
      const filtered = availableFields.filter(f => f.toLowerCase().includes(query));
      if (filtered.length > 0) {
        setSuggestion({ fields: filtered, query, start: cursor - match[0].length, cursorPos: cursor });
        setSelectedIdx(0);
      } else {
        setSuggestion(null);
      }
    } else {
      setSuggestion(null);
    }
  };

  const handleKeyDown = (e) => {
    if (!suggestion) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, suggestion.fields.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      const field = suggestion.fields[selectedIdx];
      const val = ta.value;
      const before = val.slice(0, suggestion.cursorPos);
      const matchIdx = before.lastIndexOf("{{");
      const newVal = val.slice(0, matchIdx) + `{{${field}}}` + val.slice(suggestion.cursorPos);
      onChange(newVal);
      setSuggestion(null);
      setTimeout(() => {
        ta.focus();
        const pos = matchIdx + field.length + 4;
        ta.setSelectionRange(pos, pos);
      }, 0);
    }
    if (e.key === "Escape") setSuggestion(null);
  };

  const isEmpty = !value || value === "<br>" || value === "<div><br></div>" || value === "<p><br></p>";

  return (
    <div className="flex flex-col gap-1 relative">
      {label && <label className="text-sm font-semibold text-slate-700">{label}</label>}
      
      {isPlainText ? (
        <div className="relative">
          <textarea
            ref={node => setTa(node)}
            className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 min-h-[120px] resize-y font-mono bg-white shadow-sm leading-relaxed"
            rows={rows}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onBlur={() => setTimeout(() => setSuggestion(null), 150)}
            placeholder={placeholder}
          />
          {suggestion && (
            <div className="absolute z-50 bg-white border border-slate-200 rounded-xl shadow-xl w-64 max-h-48 overflow-y-auto"
              style={{ top: "100%", left: 0, marginTop: 2 }}>
              <div className="px-3.5 py-2 border-b border-slate-100 text-xs text-slate-400 font-semibold">
                Variables — press Tab or Enter to insert
              </div>
              {suggestion.fields.map((f, i) => (
                <button
                  key={f}
                  type="button"
                  onMouseDown={() => {
                    const field = f;
                    const val = ta.value;
                    const before = val.slice(0, ta.selectionStart);
                    const matchIdx = before.lastIndexOf("{{");
                    const newVal = val.slice(0, matchIdx) + `{{${field}}}` + val.slice(ta.selectionStart);
                    onChange(newVal);
                    setSuggestion(null);
                    setTimeout(() => {
                      ta.focus();
                      const pos = matchIdx + field.length + 4;
                      ta.setSelectionRange(pos, pos);
                    }, 0);
                  }}
                  className={`w-full text-left px-3.5 py-2 text-sm flex items-center gap-2 transition-colors ${i === selectedIdx ? "bg-slate-900 text-white" : "hover:bg-slate-50 text-slate-700"}`}
                >
                  <span className="font-mono text-xs opacity-60">{"{{"}</span>
                  <span className="font-medium">{f}</span>
                  <span className="font-mono text-xs opacity-60">{"}}"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="border border-slate-200 rounded-xl overflow-hidden focus-within:ring-2 focus-within:ring-indigo-500/20 focus-within:border-indigo-500 bg-white shadow-sm transition-all">
          {/* Rich Editor Toolbar */}
          <div className="flex items-center flex-wrap gap-0.5 p-1.5 bg-slate-50 border-b border-slate-200 select-none">
            <button
              type="button"
              onMouseDown={e => handleToolbarClick(e, "bold")}
              className="p-1 h-7 min-w-[28px] hover:bg-slate-200 rounded text-slate-700 flex items-center justify-center font-bold text-xs transition-colors"
              title="Bold"
            >
              B
            </button>
            <button
              type="button"
              onMouseDown={e => handleToolbarClick(e, "italic")}
              className="p-1 h-7 min-w-[28px] hover:bg-slate-200 rounded text-slate-700 flex items-center justify-center italic font-bold text-xs transition-colors"
              title="Italic"
            >
              I
            </button>
            <button
              type="button"
              onMouseDown={e => handleToolbarClick(e, "underline")}
              className="p-1 h-7 min-w-[28px] hover:bg-slate-200 rounded text-slate-700 flex items-center justify-center underline font-bold text-xs transition-colors"
              title="Underline"
            >
              U
            </button>
            <div className="w-[1px] h-4 bg-slate-200 mx-1" />
            <button
              type="button"
              onMouseDown={e => handleToolbarClick(e, "insertUnorderedList")}
              className="p-1 h-7 min-w-[28px] hover:bg-slate-200 rounded text-slate-700 flex items-center justify-center transition-colors"
              title="Bullet List"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16M4 6h.01M4 12h.01M4 18h.01" /></svg>
            </button>
            <button
              type="button"
              onMouseDown={e => handleToolbarClick(e, "createLink")}
              className="p-1 h-7 min-w-[28px] hover:bg-slate-200 rounded text-slate-700 flex items-center justify-center transition-colors"
              title="Insert Link"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /></svg>
            </button>
            <button
              type="button"
              onMouseDown={e => handleToolbarClick(e, "unlink")}
              className="p-1 h-7 min-w-[28px] hover:bg-slate-200 rounded text-slate-700 flex items-center justify-center transition-colors"
              title="Remove Link"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636" /></svg>
            </button>
            <div className="w-[1px] h-4 bg-slate-200 mx-1" />
            <button
              type="button"
              onMouseDown={e => handleToolbarClick(e, "removeFormat")}
              className="p-1 h-7 min-w-[28px] hover:bg-slate-200 rounded text-slate-700 flex items-center justify-center text-xs font-bold transition-colors"
              title="Clear Formatting"
            >
              Tx
            </button>
          </div>
          {/* Editable Div Container */}
          <div className="relative min-h-[150px]">
            <div
              ref={editorRef}
              contentEditable
              onInput={handleInput}
              onBlur={handleInput}
              className="w-full px-3.5 py-2.5 text-sm focus:outline-none min-h-[150px] overflow-y-auto leading-relaxed font-sans bg-white rich-editor-content"
            />
            {isEmpty && (
              <div className="absolute top-2.5 left-3.5 text-sm text-slate-400 pointer-events-none select-none">
                {placeholder}
              </div>
            )}
          </div>
        </div>
      )}

      {availableFields.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {availableFields.map(f => (
            <button
              key={f}
              type="button"
              onMouseDown={e => e.preventDefault()}
              onClick={() => insertVariable(f)}
              className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-mono hover:bg-blue-100 transition-colors"
            >
              {`{{${f}}}`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function resolveSpyntax(text) {
  if (!text) return "";
  const regex = /\{([^{}]*?\|[^{}]*?)\}/g;
  let prev;
  do {
    prev = text;
    text = text.replace(regex, (match, inner) => {
      const options = inner.split("|");
      const chosen = options[Math.floor(Math.random() * options.length)];
      return chosen;
    });
  } while (text !== prev);
  return text;
}

// Convert HTML to clean plain text
function htmlToPlainText(html) {
  if (!html) return "";
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    let text = "";

    const traverse = (node) => {
      if (node.nodeType === 3) { // Text Node
        text += node.textContent;
      } else if (node.nodeType === 1) { // Element Node
        const tagName = node.tagName.toLowerCase();
        if (tagName === "br") {
          text += "\n";
        } else if (tagName === "a") {
          const href = node.getAttribute("href");
          if (href && !href.startsWith("javascript:")) {
            const tempText = node.textContent.trim();
            if (tempText && tempText !== href) {
              text += `${tempText} (${href})`;
            } else {
              text += href;
            }
          } else {
            for (let i = 0; i < node.childNodes.length; i++) {
              traverse(node.childNodes[i]);
            }
          }
        } else if (tagName === "p" || tagName === "div" || tagName === "h1" || tagName === "h2" || tagName === "h3" || tagName === "h4" || tagName === "h5" || tagName === "h6" || tagName === "li") {
          if (text && !text.endsWith("\n")) {
            text += "\n";
          }
          for (let i = 0; i < node.childNodes.length; i++) {
            traverse(node.childNodes[i]);
          }
          if (!text.endsWith("\n")) {
            text += "\n";
          }
        } else {
          for (let i = 0; i < node.childNodes.length; i++) {
            traverse(node.childNodes[i]);
          }
        }
      }
    };

    for (let i = 0; i < doc.body.childNodes.length; i++) {
      traverse(doc.body.childNodes[i]);
    }

    // Replace non-breaking spaces with normal spaces
    text = text.replace(/\u00a0/g, " ");
    
    // Clean up duplicate newlines (max 2 consecutive newlines)
    text = text.replace(/\n{3,}/g, "\n\n");
    return text.trim();
  } catch (e) {
    console.error("DOMParser error in htmlToPlainText:", e);
    let tmp = html.replace(/<br\s*\/?>/gi, "\n");
    tmp = tmp.replace(/<\/p>|<\/div>/gi, "\n");
    tmp = tmp.replace(/<[^>]+>/g, "");
    const entities = {
      "&nbsp;": " ",
      "&lt;": "<",
      "&gt;": ">",
      "&amp;": "&",
      "&quot;": '"',
      "&#39;": "'",
      "&apos;": "'"
    };
    for (const [entity, replacement] of Object.entries(entities)) {
      tmp = tmp.replaceAll(entity, replacement);
    }
    return tmp.trim();
  }
}

// Convert plain text to simple HTML wrapping
function plainTextToHtml(text) {
  if (!text) return "";
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

  return escaped
    .split("\n")
    .map(line => line.trim() === "" ? "<div><br></div>" : `<div>${line}</div>`)
    .join("");
}

// ─── Merge-tag renderer ───────────────────────────────────────────────────────
function renderTemplate(template, lead) {
  if (!template) return "";
  if (!lead) return resolveSpyntax(template);
  const fields = {
    first_name: lead.first_name || "",
    last_name: lead.last_name || "",
    email: lead.email || "",
    company: lead.company || "",
    website: lead.website || "",
    ...(lead.custom_fields || {}),
  };
  const replaced = template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    fields[key] !== undefined ? (fields[key] || `{{${key}}}`) : `{{${key}}}`
  );
  return resolveSpyntax(replaced);
}

// ─── Sequence Preview Modal ───────────────────────────────────────────────────
function SequencePreview({ steps, leads, onClose }) {
  const [previewLead, setPreviewLead] = useState(leads[0] || null);
  const [searchTerm, setSearchTerm] = useState("");

  const filteredLeads = leads.filter(l =>
    `${l.first_name} ${l.last_name} ${l.email} ${l.company || ""}`.toLowerCase().includes(searchTerm.toLowerCase())
  ).slice(0, 50);

  return createPortal(
    <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col border border-slate-100 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-slate-50/50 rounded-t-2xl">
          <div>
            <h3 className="font-bold text-slate-900 text-base">Sequence Preview</h3>
            <p className="text-xs text-slate-400 mt-0.5">Visualize your personalized email steps using dynamic lead data.</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition-colors text-xl font-medium">✕</button>
        </div>
        <div className="flex flex-1 overflow-hidden">
          {/* Lead picker sidebar */}
          <div className="w-64 border-r border-slate-100 flex flex-col bg-slate-50/30">
            <div className="p-3 border-b border-slate-100">
              <input
                className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 bg-white placeholder:text-slate-400 font-semibold"
                placeholder="Search leads..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
              />
            </div>
            <div className="overflow-y-auto flex-1">
              {filteredLeads.length === 0 && (
                <p className="text-xs text-slate-400 p-4 text-center">No matching leads found.</p>
              )}
              {filteredLeads.map(l => (
                <button
                  key={l.id}
                  onClick={() => setPreviewLead(l)}
                  className={`w-full text-left px-4 py-3 text-xs border-b border-slate-100 transition-all ${previewLead?.id === l.id
                      ? "bg-indigo-600 text-white shadow-sm"
                      : "hover:bg-slate-50 text-slate-700"
                    }`}
                >
                  <div className="font-bold truncate">{[l.first_name, l.last_name].filter(Boolean).join(" ") || "Unnamed Lead"}</div>
                  <div className={`truncate mt-0.5 text-[10px] font-mono ${previewLead?.id === l.id ? "text-indigo-200" : "text-slate-400"}`}>{l.email}</div>
                  {l.company && <div className={`truncate mt-1 text-[10px] uppercase tracking-wider font-semibold ${previewLead?.id === l.id ? "text-indigo-100" : "text-slate-400"}`}>{l.company}</div>}
                </button>
              ))}
            </div>
          </div>

          {/* Email steps preview */}
          <div className="flex-1 overflow-y-auto p-6">
            {steps.length === 0 && (
              <p className="text-gray-400 text-sm text-center mt-8">No sequence steps yet. Add steps to preview.</p>
            )}
            {steps.map((step, i) => (
              <div key={i} className="mb-8">
                <div className="flex items-center gap-3 mb-3">
                  <span className="w-6 h-6 bg-gray-900 text-white rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">{step.step_number}</span>
                  <span className="text-sm font-medium text-gray-700">
                    {i === 0 ? "Sent immediately" : `Sent after ${step.delay_days_min}–${step.delay_days_max} days`}
                  </span>
                  {!previewLead && <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">Select a lead to preview merge tags</span>}
                </div>
                <div className="border border-gray-200 rounded-xl overflow-hidden">
                  {/* Email header */}
                  <div className="bg-gray-50 px-4 py-3 border-b border-gray-200 space-y-1">
                    <div className="flex gap-2 text-xs">
                      <span className="text-gray-400 w-12">From:</span>
                      <span className="text-gray-600">Your connected email account</span>
                    </div>
                    <div className="flex gap-2 text-xs">
                      <span className="text-gray-400 w-12">To:</span>
                      <span className="text-gray-600">{previewLead ? previewLead.email : "lead@example.com"}</span>
                    </div>
                    <div className="flex gap-2 text-xs">
                      <span className="text-gray-400 w-12">Subject:</span>
                      <span className="text-gray-900 font-medium">
                        {step.subject
                          ? <HighlightedPreview text={renderTemplate(step.subject, previewLead)} raw={step.subject} />
                          : <span className="text-gray-400 italic">(no subject)</span>
                        }
                      </span>
                    </div>
                  </div>
                  {/* Email body */}
                  <div className="p-4 bg-white border border-slate-100 rounded-lg">
                    {step.body ? (
                      step.is_plain_text ? (
                        <div className="text-sm text-slate-800 whitespace-pre-wrap font-sans leading-relaxed">
                          <HighlightedPreview text={renderTemplate(step.body, previewLead)} raw={step.body} />
                        </div>
                      ) : (
                        <div 
                          className="text-sm text-slate-800 preview-html-body font-sans leading-relaxed"
                          dangerouslySetInnerHTML={{
                            __html: renderTemplate(step.body, previewLead)
                          }}
                        />
                      )
                    ) : (
                      <p className="text-gray-400 text-sm italic">(no body)</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

// Highlights substituted variables green, unfilled ones red
function HighlightedPreview({ text, raw }) {
  if (!text) return null;
  // Find remaining unsubstituted variables
  const parts = text.split(/(\{\{[^}]+\}\})/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("{{") && part.endsWith("}}")
          ? <span key={i} className="bg-red-100 text-red-700 rounded px-0.5 font-medium">{part}</span>
          : part
      )}
    </>
  );
}

// ─── Activity Feed ────────────────────────────────────────────────────────────
function ActivityFeed({ campaignId }) {
  const [events, setEvents] = useState([]);
  const [summary, setSummary] = useState({});
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("ALL");
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const PAGE_SIZE = 50;

  const load = useCallback(async (pageNum = 0, filterType = filter) => {
    setLoading(true);
    try {
      const typeParam = filterType !== "ALL" ? `&event_type=${filterType}` : "";
      const [feed, sum] = await Promise.all([
        api("GET", `/campaigns/${campaignId}/activity?skip=${pageNum * PAGE_SIZE}&limit=${PAGE_SIZE}${typeParam}`),
        api("GET", `/campaigns/${campaignId}/activity/summary`),
      ]);
      setEvents(feed.events);
      setTotal(feed.total);
      setHasMore(feed.has_more);
      setSummary(sum);
    } finally {
      setLoading(false);
    }
  }, [campaignId, filter]);

  useEffect(() => { load(0, filter); setPage(0); }, [filter]);

  // Auto-refresh every 30s
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => load(page, filter), 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, page, filter, load]);

  const EVENT_META = {
    SENT: { color: "bg-green-100 text-green-800", dot: "bg-green-500", icon: "✉", label: "Sent" },
    SCHEDULED: { color: "bg-blue-100 text-blue-800", dot: "bg-blue-400", icon: "🕐", label: "Scheduled" },
    FAILED: { color: "bg-red-100 text-red-800", dot: "bg-red-500", icon: "✗", label: "Failed" },
    CANCELLED: { color: "bg-gray-100 text-gray-600", dot: "bg-gray-400", icon: "⊘", label: "Cancelled" },
    REPLIED: { color: "bg-purple-100 text-purple-800", dot: "bg-purple-500", icon: "↩", label: "Replied" },
    BOUNCED: { color: "bg-orange-100 text-orange-800", dot: "bg-orange-500", icon: "⚠", label: "Bounced" },
  };

  const filters = ["ALL", "SCHEDULED", "SENT", "REPLIED", "FAILED", "CANCELLED", "BOUNCED"];

  const formatTime = (ts) => {
    if (!ts) return "—";
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (diff < 0) {
      // Future (scheduled)
      const futureMins = Math.floor(-diff / 60000);
      const futureHours = Math.floor(-diff / 3600000);
      const futureDays = Math.floor(-diff / 86400000);
      if (futureDays > 0) return `in ${futureDays}d ${Math.floor((-diff % 86400000) / 3600000)}h`;
      if (futureHours > 0) return `in ${futureHours}h ${Math.floor((-diff % 3600000) / 60000)}m`;
      return `in ${futureMins}m`;
    }
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  const formatExact = (ts) => {
    if (!ts) return "—";
    return new Date(ts).toLocaleString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  };

  return (
    <div>
      {/* Summary bar */}
      <div className="grid grid-cols-6 gap-2 mb-5">
        {[
          ["SCHEDULED", "blue"],
          ["SENT", "green"],
          ["REPLIED", "purple"],
          ["FAILED", "red"],
          ["CANCELLED", "gray"],
          ["BOUNCED", "orange"],
        ].map(([type, color]) => {
          const colorMap = {
            blue: "border-blue-200 bg-blue-50 text-blue-800",
            green: "border-green-200 bg-green-50 text-green-800",
            purple: "border-purple-200 bg-purple-50 text-purple-800",
            red: "border-red-200 bg-red-50 text-red-800",
            gray: "border-gray-200 bg-gray-50 text-gray-600",
            orange: "border-orange-200 bg-orange-50 text-orange-800",
          };
          return (
            <button
              key={type}
              onClick={() => setFilter(filter === type ? "ALL" : type)}
              className={`rounded-xl border p-3 text-center transition-all ${colorMap[color]} ${filter === type ? "ring-2 ring-offset-1 ring-gray-400 shadow-sm" : "hover:shadow-sm"}`}
            >
              <p className="text-xl font-bold">{summary[type] ?? 0}</p>
              <p className="text-xs font-medium mt-0.5">{EVENT_META[type]?.label}</p>
            </button>
          );
        })}
      </div>

      {/* Controls */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
          {filters.map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors capitalize ${filter === f ? "bg-white shadow-sm text-gray-900" : "text-gray-500 hover:text-gray-700"}`}
            >
              {f === "ALL" ? "All Events" : EVENT_META[f]?.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="rounded"
            />
            Auto-refresh (30s)
          </label>
          <Button size="sm" variant="secondary" onClick={() => load(page, filter)}>
            ↻ Refresh
          </Button>
        </div>
      </div>

      {/* Event count */}
      <p className="text-xs text-gray-400 mb-3">{total} total events</p>

      {/* Timeline */}
      {loading && events.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">Loading activity...</div>
      ) : events.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          <p className="text-3xl mb-2">📭</p>
          <p className="text-sm">No activity yet for this filter.</p>
          <p className="text-xs mt-1 text-gray-300">Emails will appear here once the campaign starts sending.</p>
        </div>
      ) : (
        <div className="relative">
          {/* Vertical timeline line */}
          <div className="absolute left-[19px] top-0 bottom-0 w-px bg-gray-200" />

          <div className="flex flex-col gap-0">
            {events.map((ev, idx) => {
              const meta = EVENT_META[ev.event_type] || EVENT_META["SENT"];
              const isScheduled = ev.event_type === "SCHEDULED";
              const isFuture = isScheduled && ev.scheduled_for && new Date(ev.scheduled_for) > new Date();

              return (
                <div key={`${ev.event_type}-${ev.id}-${idx}`} className="flex gap-4 group">
                  {/* Timeline dot */}
                  <div className="flex flex-col items-center flex-shrink-0" style={{ width: 40 }}>
                    <div className={`w-5 h-5 rounded-full border-2 border-white shadow-sm flex items-center justify-center z-10 mt-3 ${meta.dot}`}>
                      <span className="text-white text-[9px] leading-none">{meta.icon}</span>
                    </div>
                  </div>

                  {/* Event card */}
                  <div className={`flex-1 mb-2 rounded-xl border p-3.5 transition-shadow group-hover:shadow-sm ${isFuture ? "border-blue-200 bg-blue-50/40" : "border-gray-100 bg-white"}`}>
                    <div className="flex items-start justify-between gap-2">
                      {/* Left: who + what */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${meta.color}`}>
                            {meta.icon} {meta.label}
                          </span>
                          {ev.sequence_step && (
                            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">
                              Step {ev.sequence_step}
                            </span>
                          )}
                          {isFuture && (
                            <span className="text-xs text-blue-600 font-medium animate-pulse">
                              ● upcoming
                            </span>
                          )}
                        </div>

                        <div className="mt-1.5 flex items-center gap-1.5">
                          <span className="text-sm font-medium text-gray-900 truncate">
                            {ev.lead_name || ev.lead_email}
                          </span>
                          {ev.lead_name && (
                            <span className="text-xs text-gray-400 truncate">({ev.lead_email})</span>
                          )}
                        </div>

                        {ev.email_account && (
                          <div className="mt-1 text-xs text-gray-400">
                            via <span className="font-mono text-gray-500">{ev.email_account}</span>
                          </div>
                        )}

                        {/* Extra details */}
                        {ev.error_message && (
                          <div className="mt-2 text-xs text-red-600 bg-red-50 rounded-lg px-2.5 py-1.5 font-mono">
                            ✗ {ev.error_message}
                          </div>
                        )}
                        {ev.cancel_reason && (
                          <div className="mt-2 text-xs text-gray-500 bg-gray-50 rounded-lg px-2.5 py-1.5">
                            Reason: <span className="font-medium">{ev.cancel_reason.replace(/_/g, " ")}</span>
                          </div>
                        )}
                        {isScheduled && ev.scheduled_for && (
                          <div className="mt-2 text-xs text-blue-700 bg-blue-50 rounded-lg px-2.5 py-1.5">
                            📅 Scheduled for: <span className="font-semibold">{formatExact(ev.scheduled_for)}</span>
                          </div>
                        )}
                      </div>

                      {/* Right: timestamp */}
                      <div className="text-right flex-shrink-0">
                        <span
                          className="text-xs text-gray-400 cursor-help"
                          title={formatExact(ev.timestamp)}
                        >
                          {formatTime(ev.timestamp)}
                        </span>
                        <div className="text-[10px] text-gray-300 mt-0.5 whitespace-nowrap">
                          {formatExact(ev.timestamp)}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Pagination */}
      {(hasMore || page > 0) && (
        <div className="flex items-center justify-between mt-4">
          <p className="text-xs text-gray-400">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" disabled={page === 0}
              onClick={() => { const p = page - 1; setPage(p); load(p, filter); }}>
              ← Prev
            </Button>
            <Button size="sm" variant="secondary" disabled={!hasMore}
              onClick={() => { const p = page + 1; setPage(p); load(p, filter); }}>
              Next →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Analytics Dashboard ──────────────────────────────────────────────────────
function AnalyticsDashboard({ campaignId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [section, setSection] = useState("overview");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api("GET", `/campaigns/${campaignId}/analytics`);
      setData(result);
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="text-center py-16 text-gray-400 text-sm">Loading analytics...</div>;
  if (!data) return <div className="text-center py-16 text-gray-400 text-sm">No data yet.</div>;

  const { overall, per_step, per_account } = data;

  const HEALTH_COLORS = {
    HEALTHY: "bg-green-100 text-green-800",
    WARMING: "bg-blue-100 text-blue-800",
    THROTTLED: "bg-yellow-100 text-yellow-800",
    PAUSED: "bg-red-100 text-red-800",
  };

  // Mini bar component
  const MiniBar = ({ value, max, color = "bg-blue-500" }) => {
    const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="text-xs text-gray-500 w-8 text-right">{value}</span>
      </div>
    );
  };

  // Stat card
  const StatCard = ({ label, value, sub, color = "text-gray-900", bg = "bg-white" }) => (
    <div className={`${bg} border border-gray-200 rounded-xl p-4`}>
      <p className="text-xs text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );

  // Rate pill
  const Rate = ({ value, warn = 10, danger = 20, suffix = "%" }) => {
    const color = value >= danger ? "text-red-600 bg-red-50" :
      value >= warn ? "text-yellow-700 bg-yellow-50" :
        "text-green-700 bg-green-50";
    return (
      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${color}`}>
        {value}{suffix}
      </span>
    );
  };

  const sections = ["overview", "by step", "by account"];

  return (
    <div>
      {/* Section tabs */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit mb-6">
        {sections.map(s => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium capitalize transition-colors ${section === s ? "bg-white shadow-sm text-gray-900" : "text-gray-500 hover:text-gray-700"
              }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
        <Button size="sm" variant="ghost" onClick={load} className="ml-2">↻</Button>
      </div>

      {/* ── OVERVIEW ── */}
      {section === "overview" && (
        <div className="flex flex-col gap-6">

          {/* Lead funnel */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Lead Funnel</h3>
            <div className="grid grid-cols-5 gap-2">
              {[
                { label: "Total Leads", value: overall.total_leads, color: "text-gray-900" },
                { label: "New", value: overall.new, color: "text-gray-600" },
                { label: "Contacted", value: overall.contacted, color: "text-blue-600" },
                { label: "Replied", value: overall.replied, color: "text-green-600", bg: overall.replied > 0 ? "bg-green-50" : "bg-white" },
                { label: "Bounced", value: overall.bounced, color: "text-red-600", bg: overall.bounced > 0 ? "bg-red-50" : "bg-white" },
              ].map(s => (
                <StatCard key={s.label} {...s} />
              ))}
            </div>

            {/* Visual funnel bar */}
            {overall.total_leads > 0 && (
              <div className="mt-4 space-y-2">
                {[
                  { label: "Contacted", value: overall.contacted, color: "bg-blue-500" },
                  { label: "Replied", value: overall.replied, color: "bg-green-500" },
                  { label: "Bounced", value: overall.bounced, color: "bg-red-400" },
                ].map(row => (
                  <div key={row.label} className="flex items-center gap-3">
                    <span className="text-xs text-gray-500 w-20 text-right">{row.label}</span>
                    <div className="flex-1 h-5 bg-gray-100 rounded-lg overflow-hidden">
                      <div
                        className={`h-full ${row.color} rounded-lg transition-all flex items-center justify-end pr-2`}
                        style={{ width: `${Math.max((row.value / overall.total_leads) * 100, row.value > 0 ? 2 : 0)}%` }}
                      >
                        {row.value > 0 && (
                          <span className="text-white text-xs font-bold">
                            {Math.round((row.value / overall.total_leads) * 100)}%
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-xs text-gray-500 w-8">{row.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Email metrics */}
          <div>
            <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Email Metrics</h3>
            <div className="grid grid-cols-4 gap-2 mb-4">
              {[
                { label: "Sent", value: overall.emails_sent, color: "text-gray-900" },
                { label: "Scheduled", value: overall.emails_scheduled, color: "text-blue-600" },
                { label: "Failed", value: overall.emails_failed, color: overall.emails_failed > 0 ? "text-red-600" : "text-gray-900", bg: overall.emails_failed > 0 ? "bg-red-50" : "bg-white" },
                { label: "Cancelled", value: overall.emails_cancelled, color: "text-gray-500" },
              ].map(s => <StatCard key={s.label} {...s} />)}
            </div>

            {/* Rate grid */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Delivery Rate", value: overall.delivery_rate, warn: 0, danger: 0, good: 95 },
                { label: "Open Rate", value: overall.open_rate, warn: 0, danger: 0 },
                { label: "Reply Rate", value: overall.reply_rate, warn: 0, danger: 0 },
                { label: "Bounce Rate", value: overall.bounce_rate, warn: 5, danger: 10 },
              ].map(({ label, value, warn, danger }) => (
                <div key={label} className="border border-gray-200 rounded-xl p-4 bg-white flex items-center justify-between">
                  <span className="text-sm text-gray-600">{label}</span>
                  <Rate value={value} warn={warn} danger={danger} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── BY STEP ── */}
      {section === "by step" && (
        <div>
          {per_step.length === 0 ? (
            <div className="text-center py-16 text-gray-400 text-sm">No sequence steps found.</div>
          ) : (
            <div className="flex flex-col gap-3">
              {per_step.map((step) => (
                <div key={step.step_number} className="border border-gray-200 rounded-xl overflow-hidden bg-white">
                  {/* Step header */}
                  <div className="bg-gray-50 border-b border-gray-200 px-4 py-3 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="w-7 h-7 bg-gray-900 text-white rounded-full flex items-center justify-center text-xs font-bold">
                        {step.step_number}
                      </span>
                      <div>
                        <p className="text-sm font-medium text-gray-900 truncate max-w-xs">
                          {step.subject || "(no subject)"}
                        </p>
                        <p className="text-xs text-gray-400">{step.delay}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {step.sent > 0 && <Rate value={step.reply_rate} warn={0} danger={0} />}
                      <span className="text-xs text-gray-500">{step.sent} sent</span>
                      {step.scheduled > 0 && (
                        <span className="text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                          {step.scheduled} scheduled
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Step stats */}
                  <div className="p-4 grid grid-cols-6 gap-4">
                    {[
                      { label: "Sent", value: step.sent, bar: step.sent, max: step.sent, color: "bg-gray-400" },
                      { label: "Opened", value: step.opened, bar: step.opened, max: step.sent, color: "bg-blue-500" },
                      { label: "Clicked", value: step.clicked, bar: step.clicked, max: step.sent, color: "bg-indigo-500" },
                      { label: "Replied", value: step.replied, bar: step.replied, max: step.sent, color: "bg-green-500" },
                      { label: "Bounced", value: step.bounced, bar: step.bounced, max: step.sent, color: "bg-red-400" },
                      { label: "Failed", value: step.failed, bar: step.failed, max: step.sent, color: "bg-orange-400" },
                    ].map(col => (
                      <div key={col.label}>
                        <p className="text-xs text-gray-400 mb-1.5">{col.label}</p>
                        <p className="text-lg font-bold text-gray-900 mb-1.5">{col.value}</p>
                        <MiniBar value={col.bar} max={col.max || 1} color={col.color} />
                        {col.max > 0 && (
                          <p className="text-xs text-gray-400 mt-1">
                            {Math.round((col.value / col.max) * 100)}%
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── BY ACCOUNT ── */}
      {section === "by account" && (
        <div>
          {per_account.length === 0 ? (
            <div className="text-center py-16 text-gray-400 text-sm">
              No accounts assigned to this campaign yet.
            </div>
          ) : (
            <>
              {/* Table header */}
              <div className="border border-gray-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      {["Account", "Health", "Sent", "Replied", "Bounced", "Reply Rate", "Bounce Rate", "Today"].map(h => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {per_account.map(acct => (
                      <tr key={acct.account_id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3">
                          <p className="font-medium text-gray-900">{acct.name}</p>
                          <p className="text-xs text-gray-400 font-mono">{acct.email}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${HEALTH_COLORS[acct.health_status] || "bg-gray-100 text-gray-600"}`}>
                            {acct.health_status}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-medium">{acct.sent}</td>
                        <td className="px-4 py-3 text-green-700 font-medium">{acct.replied}</td>
                        <td className="px-4 py-3 text-red-600 font-medium">{acct.bounced}</td>
                        <td className="px-4 py-3">
                          <Rate value={acct.reply_rate} warn={0} danger={0} />
                        </td>
                        <td className="px-4 py-3">
                          <Rate value={acct.bounce_rate} warn={5} danger={10} />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-600">{acct.sent_today}/{acct.daily_limit}</span>
                            <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${(acct.sent_today / acct.daily_limit) >= 0.9 ? "bg-red-500" :
                                  (acct.sent_today / acct.daily_limit) >= 0.7 ? "bg-yellow-500" : "bg-green-500"
                                  }`}
                                style={{ width: `${Math.min((acct.sent_today / acct.daily_limit) * 100, 100)}%` }}
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Account comparison bars */}
              {per_account.length > 1 && (
                <div className="mt-4 border border-gray-200 rounded-xl p-4 bg-white">
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
                    Send Volume Comparison
                  </h4>
                  <div className="flex flex-col gap-3">
                    {per_account.map(acct => {
                      const maxSent = Math.max(...per_account.map(a => a.sent), 1);
                      return (
                        <div key={acct.account_id} className="flex items-center gap-3">
                          <span className="text-xs text-gray-500 w-32 truncate">{acct.name}</span>
                          <div className="flex-1 h-6 bg-gray-100 rounded-lg overflow-hidden">
                            <div
                              className="h-full bg-gray-800 rounded-lg flex items-center justify-end pr-2 transition-all"
                              style={{ width: `${Math.max((acct.sent / maxSent) * 100, acct.sent > 0 ? 3 : 0)}%` }}
                            >
                              {acct.sent > 0 && (
                                <span className="text-white text-xs font-bold">{acct.sent}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}


// ─── Lead Status Dropdown ─────────────────────────────────────────────────────
function LeadStatusDropdown({ lead, campaignId, onUpdated }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showNote, setShowNote] = useState(false);
  const [pendingStatus, setPendingStatus] = useState(null);
  const [note, setNote] = useState("");

  const STATUS_GROUPS = [
    {
      label: "Pipeline",
      statuses: [
        { value: "NEW", label: "New", color: "text-gray-600" },
        { value: "CONTACTED", label: "Contacted", color: "text-blue-600" },
        { value: "REPLIED", label: "Replied", color: "text-purple-600" },
        { value: "INTERESTED", label: "✓ Interested", color: "text-green-600" },
        { value: "MEETING_BOOKED", label: "📅 Meeting Booked", color: "text-green-700" },
      ],
    },
    {
      label: "Not a Fit",
      statuses: [
        { value: "NOT_INTERESTED", label: "✗ Not Interested", color: "text-red-600" },
        { value: "WRONG_PERSON", label: "✗ Wrong Person", color: "text-red-600" },
        { value: "OUT_OF_OFFICE", label: "🏖 Out of Office", color: "text-yellow-600" },
      ],
    },
    {
      label: "Stop Sending",
      statuses: [
        { value: "DO_NOT_CONTACT", label: "🚫 Do Not Contact", color: "text-red-700" },
        { value: "BOUNCED", label: "Bounced", color: "text-red-600" },
        { value: "UNSUBSCRIBED", label: "Unsubscribed", color: "text-gray-500" },
      ],
    },
  ];

  const handleSelect = (status) => {
    setPendingStatus(status);
    setNote("");
    setOpen(false);
    setShowNote(true);
  };

  const confirm = async () => {
    setLoading(true);
    try {
      await api("PATCH", `/campaigns/${campaignId}/leads/${lead.id}/status`, {
        status: pendingStatus,
        note: note || undefined,
      });
      setShowNote(false);
      onUpdated();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Note/confirm modal */}
      {showNote && createPortal(
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => setShowNote(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5"
            onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-gray-900 mb-1">
              Change status to <StatusBadge status={pendingStatus} />
            </h3>
            <p className="text-xs text-gray-400 mb-3">
              {lead.first_name || lead.email}
            </p>
            <textarea
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-gray-900"
              rows={3}
              placeholder="Add a note (optional)..."
              value={note}
              onChange={e => setNote(e.target.value)}
            />
            <div className="flex gap-2 mt-3">
              <Button
                onClick={confirm}
                disabled={loading}
                className="flex-1 justify-center"
              >
                {loading ? "Saving..." : "Confirm"}
              </Button>
              <Button
                variant="secondary"
                className="flex-1 justify-center"
                onClick={() => setShowNote(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Dropdown trigger */}
      <div className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 hover:opacity-80 transition-opacity"
        >
          <StatusBadge status={lead.status} />
          <span className="text-gray-400 text-xs">▾</span>
        </button>

        {open && (
          <div
            className="absolute z-40 top-full left-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-xl w-52 py-1 overflow-hidden"
            onMouseLeave={() => setOpen(false)}
          >
            {STATUS_GROUPS.map((group, gi) => (
              <div key={gi}>
                <div className="px-3 py-1.5 text-xs font-semibold text-gray-400 uppercase tracking-wide bg-gray-50 border-b border-gray-100">
                  {group.label}
                </div>
                {group.statuses.map(s => (
                  <button
                    key={s.value}
                    onClick={() => handleSelect(s.value)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors flex items-center justify-between ${s.color} ${lead.status === s.value ? "bg-gray-50 font-semibold" : ""}`}
                  >
                    {s.label}
                    {lead.status === s.value && <span className="text-gray-400">✓</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}


// ─── Lead Status Overview ─────────────────────────────────────────────────────
function LeadStatusOverview({ campaignId, leads }) {
  const STATUS_CONFIG = [
    { status: "NEW", label: "New", color: "bg-gray-100 text-gray-700", dot: "bg-gray-400" },
    { status: "CONTACTED", label: "Contacted", color: "bg-blue-100 text-blue-800", dot: "bg-blue-500" },
    { status: "REPLIED", label: "Replied", color: "bg-purple-100 text-purple-800", dot: "bg-purple-500" },
    { status: "INTERESTED", label: "Interested", color: "bg-green-100 text-green-800", dot: "bg-green-500" },
    { status: "MEETING_BOOKED", label: "Meeting", color: "bg-green-200 text-green-900", dot: "bg-green-600" },
    { status: "NOT_INTERESTED", label: "Not Int.", color: "bg-red-100 text-red-700", dot: "bg-red-400" },
    { status: "WRONG_PERSON", label: "Wrong Person", color: "bg-red-100 text-red-700", dot: "bg-red-400" },
    { status: "DO_NOT_CONTACT", label: "DNC", color: "bg-red-200 text-red-900", dot: "bg-red-600" },
    { status: "OUT_OF_OFFICE", label: "OOO", color: "bg-yellow-100 text-yellow-800", dot: "bg-yellow-500" },
    { status: "BOUNCED", label: "Bounced", color: "bg-orange-100 text-orange-800", dot: "bg-orange-500" },
  ];

  const counts = {};
  leads.forEach(l => { counts[l.status] = (counts[l.status] || 0) + 1; });

  const active = STATUS_CONFIG.filter(s => counts[s.status] > 0);
  if (active.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 mb-4">
      {active.map(s => (
        <div key={s.status} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium ${s.color}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
          {s.label}
          <span className="font-bold">{counts[s.status]}</span>
        </div>
      ))}
    </div>
  );
}


// ─── Campaign Settings Modal ───────────────────────────────────────────────────
function CampaignSettingsTab({ campaign, onSaved, onDeleted }) {
  const [form, setForm] = useState({
    name: campaign.name || "",
    daily_email_limit: campaign.daily_email_limit || 50,
    daily_new_leads: campaign.daily_new_leads || 20,
    followup_percentage: campaign.followup_percentage || 0.7,
    sending_window_start: campaign.sending_window_start || "09:00",
    sending_window_end: campaign.sending_window_end || "17:00",
    timezone: campaign.timezone || "Asia/Kolkata",
    track_open_rate: campaign.track_open_rate !== undefined ? campaign.track_open_rate : true,
    track_reply_rate: campaign.track_reply_rate !== undefined ? campaign.track_reply_rate : true,
    active_days: {
      monday: campaign.active_days?.monday ?? true,
      tuesday: campaign.active_days?.tuesday ?? true,
      wednesday: campaign.active_days?.wednesday ?? true,
      thursday: campaign.active_days?.thursday ?? true,
      friday: campaign.active_days?.friday ?? true,
      saturday: campaign.active_days?.saturday ?? false,
      sunday: campaign.active_days?.sunday ?? false,
    },
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState([]);
  const [preview, setPreview] = useState(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);

  const timezones = [
    "Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo",
    "Europe/London", "Europe/Paris", "Europe/Berlin", "America/New_York",
    "America/Los_Angeles", "UTC",
  ];

  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const followupPct = Math.round(form.followup_percentage * 100);

  const loadHistory = useCallback(async () => {
    try {
      const data = await api("GET", `/campaigns/${campaign.id}/settings/history`);
      setHistory(data);
    } catch (e) {
      console.error(e);
    }
  }, [campaign.id]);

  useEffect(() => {
    loadHistory();
    const interval = setInterval(loadHistory, 10000);
    return () => clearInterval(interval);
  }, [loadHistory]);

  const hasPendingChanges = useMemo(() => {
    return history.some(ev => ev.applied_at === null);
  }, [history]);

  const requestPreview = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const data = await api("POST", `/campaigns/${campaign.id}/settings/change-preview`, form);
      setPreview(data);
      setShowPreviewModal(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setShowPreviewModal(false);
    try {
      await api("PATCH", `/campaigns/${campaign.id}`, form);
      onSaved();
      loadHistory();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {hasPendingChanges && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-xs p-4 rounded-xl flex items-center gap-3">
          <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 animate-spin">
            ⟳
          </div>
          <div>
            <strong className="font-bold">Settings adjustment in progress...</strong>
            <p className="mt-0.5 text-amber-700/80">We are recalculating and rescheduling your email queue in the background. Changes will take effect shortly.</p>
          </div>
        </div>
      )}

      {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs p-3 rounded-lg font-semibold">✗ {error}</div>}

      <form onSubmit={requestPreview} className="space-y-6">
        <Card className="p-6 space-y-5">
          <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-2">Campaign Settings</h3>
          <Input
            label="Campaign Name"
            placeholder="e.g. Q1 SaaS Founders Outreach"
            value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
          />

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Daily Email Limit"
              type="number" min={1} max={500}
              value={form.daily_email_limit}
              onChange={e => setForm({ ...form, daily_email_limit: +e.target.value })}
            />
            <Input
              label="New Leads / Day"
              type="number" min={1}
              value={form.daily_new_leads}
              onChange={e => setForm({ ...form, daily_new_leads: +e.target.value })}
            />
          </div>

          <div className="bg-slate-50 border border-slate-100 p-4 rounded-xl">
            <div className="flex justify-between items-center mb-3">
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Follow-up / New Ratio</label>
              <span className="text-xs font-bold text-slate-800 bg-indigo-50 border border-indigo-100 px-2 py-0.5 rounded-md">{followupPct}% / {100 - followupPct}%</span>
            </div>
            <input
              type="range" min={0} max={100} value={followupPct}
              onChange={e => setForm({ ...form, followup_percentage: +e.target.value / 100 })}
              className="w-full accent-indigo-600 cursor-pointer h-1.5 bg-slate-200 rounded-lg appearance-none"
            />
            <div className="flex justify-between mt-3 text-[10px] text-slate-400 font-bold uppercase tracking-wide">
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-indigo-600" />{followupPct}% follow-ups</span>
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-slate-400" />{100 - followupPct}% new leads</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Window Start (IST)"
              type="time"
              value={form.sending_window_start}
              onChange={e => setForm({ ...form, sending_window_start: e.target.value })}
            />
            <Input
              label="Window End (IST)"
              type="time"
              value={form.sending_window_end}
              onChange={e => setForm({ ...form, sending_window_end: e.target.value })}
            />
          </div>

          <div className="flex flex-col gap-1 w-full">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Timezone (IST recommended)</label>
            <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50/50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-100 focus:border-indigo-500 transition-all text-slate-800 font-medium"
              value={form.timezone}
              onChange={e => setForm({ ...form, timezone: e.target.value })}
            >
              {timezones.map(tz => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Active Days</label>
            <div className="flex gap-2">
              {days.map(d => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setForm({ ...form, active_days: { ...form.active_days, [d]: !form.active_days[d] } })}
                  className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all border ${form.active_days[d]
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-sm shadow-indigo-100/50"
                      : "bg-white text-slate-400 border-slate-200 hover:bg-slate-50 hover:text-slate-600"
                    }`}
                >
                  {d.slice(0, 1).toUpperCase() + d.slice(1, 2)}
                </button>
              ))}
            </div>
          </div>

          <div className="border-t border-slate-100 pt-5">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3 block">Deliverability & Tracking Settings</label>
            <div className="space-y-2.5">
              <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-100/60 rounded-xl">
                <div className="flex-1">
                  <label className="text-sm font-semibold text-slate-800 cursor-pointer block">
                    Track Open Rate
                  </label>
                  <p className="text-xs text-slate-400 mt-0.5">Injects a tracking pixel. Disable to maximize inbox deliverability.</p>
                </div>
                <label className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  style={{ backgroundColor: form.track_open_rate ? '#4f46e5' : '#cbd5e1' }}>
                  <input type="checkbox" className="sr-only"
                    checked={form.track_open_rate}
                    onChange={e => setForm({ ...form, track_open_rate: e.target.checked })}
                  />
                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out`}
                    style={{ transform: form.track_open_rate ? 'translateX(1.25rem)' : 'translateX(0)' }}
                  />
                </label>
              </div>

              <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-100/60 rounded-xl">
                <div className="flex-1">
                  <label className="text-sm font-semibold text-slate-800 cursor-pointer block">
                    Track Reply Rate
                  </label>
                  <p className="text-xs text-slate-400 mt-0.5">Monitors IMAP inbox. Disable if you prefer external reply handling.</p>
                </div>
                <label className="relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                  style={{ backgroundColor: form.track_reply_rate ? '#4f46e5' : '#cbd5e1' }}>
                  <input type="checkbox" className="sr-only"
                    checked={form.track_reply_rate}
                    onChange={e => setForm({ ...form, track_reply_rate: e.target.checked })}
                  />
                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out`}
                    style={{ transform: form.track_reply_rate ? 'translateX(1.25rem)' : 'translateX(0)' }}
                  />
                </label>
              </div>
            </div>
          </div>

          <div className="flex justify-between items-center pt-3">
            <Button
              type="button"
              variant="secondary"
              onClick={async () => {
                try {
                  const data = await api("GET", `/campaigns/${campaign.id}/export`);
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `${campaign.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_campaign_export.json`;
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                  URL.revokeObjectURL(url);
                } catch (err) {
                  alert("Failed to export campaign: " + err.message);
                }
              }}
            >
              <svg className="w-4 h-4 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Export Campaign (JSON)
            </Button>
            <Button type="submit" disabled={saving}>{saving ? "Checking Impact..." : "Save Settings Changes"}</Button>
          </div>
        </Card>
      </form>

      <Card className="p-6">
        <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-4">Settings Change History</h3>
        <div className="overflow-x-auto border border-slate-100 rounded-xl">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100 text-slate-500 uppercase tracking-wider font-bold">
                <th className="px-4 py-3">Timestamp</th>
                <th className="px-4 py-3">Parameter</th>
                <th className="px-4 py-3">Old Value</th>
                <th className="px-4 py-3">New Value</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-slate-700">
              {history.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-slate-400">No settings adjustments have been logged yet.</td>
                </tr>
              )}
              {history.map(ev => (
                <tr key={ev.id} className="hover:bg-slate-50/50">
                  <td className="px-4 py-3 whitespace-nowrap text-slate-400 font-semibold">{new Date(ev.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3 font-semibold text-slate-800">{ev.change_type.replace(/_/g, " ")}</td>
                  <td className="px-4 py-3 font-mono max-w-[150px] truncate" title={ev.old_value}>{ev.old_value || "—"}</td>
                  <td className="px-4 py-3 font-mono max-w-[150px] truncate text-slate-900 font-medium" title={ev.new_value}>{ev.new_value || "—"}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {ev.applied_at ? (
                      <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-bold border border-emerald-100">Applied</span>
                    ) : (
                      <span className="px-2 py-0.5 rounded bg-amber-50 text-amber-700 font-bold border border-amber-100 animate-pulse">Pending</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500 max-w-[200px] truncate" title={ev.cascade_result}>{ev.cascade_result || "Queueing..."}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-6 border-rose-100 bg-rose-50/10">
        <h3 className="text-sm font-bold text-rose-900 uppercase tracking-wider mb-2">Danger Zone</h3>
        <p className="text-xs text-slate-500 mb-4">Deleting a campaign will permanently remove all associated leads, sequence templates, analytics, history logs, and scheduled emails. This action cannot be undone.</p>
        <div className="flex justify-start">
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              if (confirm(`Are you sure you want to permanently delete the campaign "${campaign.name}"? This will delete all sequences, leads, history logs, and scheduled emails. This action is irreversible.`)) {
                setLoading(true);
                try {
                  await api("DELETE", `/campaigns/${campaign.id}`);
                  if (onDeleted) onDeleted();
                } catch (err) {
                  alert("Failed to delete campaign: " + err.message);
                } finally {
                  setLoading(false);
                }
              }
            }}
            disabled={loading}
          >
            Delete Campaign
          </Button>
        </div>
      </Card>

      {showPreviewModal && preview && createPortal(
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 border border-slate-100">
            <h3 className="font-bold text-slate-950 text-base mb-1">Confirm Settings Adjustment</h3>
            <p className="text-xs text-slate-400 mb-4">Editing settings affects scheduled emails. Here is the calculated impact:</p>

            <div className="bg-slate-50 rounded-xl border border-slate-200/60 p-4 space-y-3 mb-6">
              <div className="flex justify-between text-xs">
                <span className="text-slate-500 font-semibold">Total scheduled emails:</span>
                <span className="text-slate-900 font-extrabold">{preview.scheduled_emails_count}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-500 font-semibold">Emails to reschedule:</span>
                <span className="text-amber-600 font-extrabold">{preview.reschedule_count}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-slate-500 font-semibold">Emails to cancel (exceeding daily limit):</span>
                <span className="text-rose-600 font-extrabold">{preview.cancel_count}</span>
              </div>
            </div>

            <p className="text-xs text-slate-500 mb-6 leading-relaxed">
              Confirming will log the settings change and queue it for asynchronous application via Celery. It will take up to a few minutes to cascade.
            </p>

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setShowPreviewModal(false)}>Go Back</Button>
              <Button size="sm" onClick={save} disabled={saving}>{saving ? "Applying..." : "Confirm & Apply"}</Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── Lead Filter Bar ───────────────────────────────────────────────────────────────
function LeadFilterBar({ filters, onFiltersChange, onExport, totalLeads, filteredCount }) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const STATUS_OPTIONS = [
    "NEW", "CONTACTED", "REPLIED", "BOUNCED", "DO_NOT_CONTACT",
    "INTERESTED", "MEETING_BOOKED", "NOT_INTERESTED", "WRONG_PERSON"
  ];

  const activeStatuses = useMemo(() => {
    return filters.status ? filters.status.split(",").filter(Boolean) : [];
  }, [filters.status]);

  const toggleStatus = (status) => {
    let nextStatuses;
    if (activeStatuses.includes(status)) {
      nextStatuses = activeStatuses.filter(s => s !== status);
    } else {
      nextStatuses = [...activeStatuses, status];
    }
    onFiltersChange({
      ...filters,
      status: nextStatuses.join(",")
    });
  };

  const removeFilter = (key, value = null) => {
    if (key === "status" && value) {
      const nextStatuses = activeStatuses.filter(s => s !== value);
      onFiltersChange({ ...filters, status: nextStatuses.join(",") });
    } else {
      onFiltersChange({ ...filters, [key]: "" });
    }
  };

  const clearAll = () => {
    onFiltersChange({
      search: "",
      status: "",
      minStep: "",
      maxStep: "",
      company: ""
    });
  };

  const hasActiveFilters = filters.search || filters.status || filters.minStep || filters.maxStep || filters.company;

  return (
    <div className="mb-6 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-4 rounded-xl border border-slate-100 shadow-sm">
        <div className="flex items-center gap-2.5 flex-1 min-w-[280px]">
          <div className="relative flex-1 max-w-md">
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            </span>
            <input
              className="w-full border border-slate-200 rounded-lg pl-9 pr-3 py-2 text-sm bg-slate-50/50 text-slate-800 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-medium transition-all"
              placeholder="Search leads by name, email, company, or custom fields..."
              value={filters.search}
              onChange={e => onFiltersChange({ ...filters, search: e.target.value })}
            />
          </div>

          <Button
            size="md"
            variant="secondary"
            onClick={() => setShowAdvanced(true)}
            className="text-xs font-semibold border-slate-200 whitespace-nowrap"
          >
            <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" /></svg>
            Advanced Filters
            {hasActiveFilters && <span className="ml-1 w-2 h-2 rounded-full bg-indigo-600" />}
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={onExport} className="text-xs font-semibold border-slate-200">
            <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            Export CSV
          </Button>
        </div>
      </div>

      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2 bg-slate-50/50 p-2.5 rounded-lg border border-slate-100">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Active Filters:</span>

          {filters.search && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-white border border-slate-200 text-slate-700 shadow-sm">
              Search: "{filters.search}"
              <button onClick={() => removeFilter("search")} className="text-slate-400 hover:text-slate-600 font-bold ml-1">✕</button>
            </span>
          )}

          {activeStatuses.map(s => (
            <span key={s} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-indigo-50 border border-indigo-100 text-indigo-700 shadow-sm">
              Status: {s.replace(/_/g, ' ')}
              <button onClick={() => removeFilter("status", s)} className="text-indigo-400 hover:text-indigo-600 font-bold ml-1">✕</button>
            </span>
          ))}

          {filters.minStep && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-white border border-slate-200 text-slate-700 shadow-sm">
              Min Step: {filters.minStep}
              <button onClick={() => removeFilter("minStep")} className="text-slate-400 hover:text-slate-600 font-bold ml-1">✕</button>
            </span>
          )}

          {filters.maxStep && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-white border border-slate-200 text-slate-700 shadow-sm">
              Max Step: {filters.maxStep}
              <button onClick={() => removeFilter("maxStep")} className="text-slate-400 hover:text-slate-600 font-bold ml-1">✕</button>
            </span>
          )}

          {filters.company && (
            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold bg-white border border-slate-200 text-slate-700 shadow-sm">
              Company: "{filters.company}"
              <button onClick={() => removeFilter("company")} className="text-slate-400 hover:text-slate-600 font-bold ml-1">✕</button>
            </span>
          )}

          <button onClick={clearAll} className="text-xs font-bold text-rose-600 hover:text-rose-700 hover:underline ml-2 transition-all">
            Clear all
          </button>

          <span className="ml-auto text-[10px] font-semibold text-slate-400">{filteredCount} matches</span>
        </div>
      )}

      {showAdvanced && createPortal(
        <div className="fixed inset-0 z-50 overflow-hidden">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm transition-opacity" onClick={() => setShowAdvanced(false)} />

          <div className="pointer-events-none fixed inset-y-0 right-0 flex max-w-full pl-10">
            <div className="pointer-events-auto w-screen max-w-sm transform bg-white shadow-2xl transition-all duration-300 ease-in-out border-l border-slate-100 flex flex-col h-full">
              <div className="px-6 py-5 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
                <div>
                  <h3 className="font-bold text-slate-900 text-base">Filters</h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">Narrow down leads in this campaign</p>
                </div>
                <button onClick={() => setShowAdvanced(false)} className="text-slate-400 hover:text-slate-700 transition-colors text-xl font-medium">✕</button>
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block">Company Name</label>
                  <input
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-slate-50/30 text-slate-800 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500 font-medium transition-all"
                    placeholder="Search by company..."
                    value={filters.company || ""}
                    onChange={e => onFiltersChange({ ...filters, company: e.target.value })}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block">Campaign Step Range</label>
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      type="number" min={0} placeholder="Min Step"
                      value={filters.minStep || ""}
                      onChange={e => onFiltersChange({ ...filters, minStep: e.target.value })}
                    />
                    <Input
                      type="number" min={0} placeholder="Max Step"
                      value={filters.maxStep || ""}
                      onChange={e => onFiltersChange({ ...filters, maxStep: e.target.value })}
                    />
                  </div>
                </div>

                <div className="space-y-2.5 border-t border-slate-100 pt-5">
                  <label className="text-xs font-bold text-slate-400 uppercase tracking-wider block">Lead Status</label>
                  <div className="grid grid-cols-1 gap-2 max-h-60 overflow-y-auto pr-1">
                    {STATUS_OPTIONS.map(status => {
                      const checked = activeStatuses.includes(status);
                      return (
                        <label key={status} className="flex items-center gap-2.5 px-3 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200/50 rounded-lg text-xs font-bold text-slate-700 cursor-pointer transition-colors">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleStatus(status)}
                            className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 w-4 h-4"
                          />
                          {status.replace(/_/g, ' ')}
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div className="px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex gap-3">
                <Button variant="secondary" onClick={clearAll} className="flex-1 text-xs">Clear Filters</Button>
                <Button onClick={() => setShowAdvanced(false)} className="flex-1 text-xs">Apply Filters</Button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── Campaign Detail (Leads + Sequence + Stats) ───────────────────────────────
function CampaignDetail({ campaign, onBack }) {
  const [currentCampaign, setCurrentCampaign] = useState(campaign);
  const [tab, setTab] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("tab") || "leads";
  });
  const [stats, setStats] = useState(null);
  const [leads, setLeads] = useState([]);
  const [sequences, setSequences] = useState([]);
  const [availableFields, setAvailableFields] = useState([]);
  const [showImport, setShowImport] = useState(false);
  const [leadFilters, setLeadFilters] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return {
      search: params.get("q") || "",
      status: params.get("status") || "",
      minStep: params.get("minStep") || "",
      maxStep: params.get("maxStep") || "",
      company: params.get("company") || "",
    };
  });
  const [leadPage, setLeadPage] = useState(0);
  const PAGE_SIZE = 100;
  const [selectedLeads, setSelectedLeads] = useState(new Set());

  useEffect(() => {
    setCurrentCampaign(campaign);
  }, [campaign]);

  // Synchronize lead filters and active tab with URL query parameters
  useEffect(() => {
    const params = new URLSearchParams();
    if (leadFilters.search) params.set("q", leadFilters.search);
    if (leadFilters.status) params.set("status", leadFilters.status);
    if (leadFilters.minStep) params.set("minStep", leadFilters.minStep);
    if (leadFilters.maxStep) params.set("maxStep", leadFilters.maxStep);
    if (leadFilters.company) params.set("company", leadFilters.company);
    params.set("tab", tab);

    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, "", newUrl);
  }, [leadFilters, tab]);

  const toggleStatus = async () => {
    const newStatus = currentCampaign.status === "ACTIVE" ? "PAUSED" : "ACTIVE";
    try {
      const updated = await api("PATCH", `/campaigns/${campaign.id}`, { status: newStatus });
      setCurrentCampaign(updated);
    } catch (err) {
      alert(err.message);
    }
  };

  const loadLeads = useCallback(() => {
    const params = new URLSearchParams();
    if (leadFilters.status) params.set("status", leadFilters.status);
    if (leadFilters.search) params.set("search", leadFilters.search);
    if (leadFilters.company) params.set("company", leadFilters.company);
    if (leadFilters.minStep && leadFilters.minStep === leadFilters.maxStep) {
      params.set("step", leadFilters.minStep);
    }
    api(`GET`, `/campaigns/${campaign.id}/leads?${params}`).then(data => {
      setLeads(data);
      setLeadPage(0);
      setSelectedLeads(new Set());
    }).catch(() => { });
  }, [campaign.id, leadFilters]);

  useEffect(() => {
    api("GET", `/campaigns/${campaign.id}/stats`).then(setStats).catch(() => { });
    loadLeads();
    api("GET", `/campaigns/${campaign.id}/sequences`).then(setSequences).catch(() => { });
    api("GET", `/campaigns/${campaign.id}/leads/fields`).then(d => setAvailableFields(d.fields || [])).catch(() => { });
  }, [campaign.id, loadLeads]);

  const tabs = ["leads", "sequence", "activity", "inboxes", "stats", "settings"];

  // Derive all column keys from leads
  const allCustomKeys = useMemo(() => {
    const keys = new Set();
    leads.forEach(l => { if (l.custom_fields) Object.keys(l.custom_fields).forEach(k => keys.add(k)); });
    return Array.from(keys).sort();
  }, [leads]);

  const allColumns = ["first_name", "last_name", "email", "company", "website", "status", "step", ...allCustomKeys];

  const filteredLeads = useMemo(() => {
    let result = leads;
    if (leadFilters.minStep) {
      result = result.filter(l => l.current_step >= parseInt(leadFilters.minStep));
    }
    if (leadFilters.maxStep) {
      result = result.filter(l => l.current_step <= parseInt(leadFilters.maxStep));
    }
    return result;
  }, [leads, leadFilters.minStep, leadFilters.maxStep]);

  const pagedLeads = filteredLeads.slice(leadPage * PAGE_SIZE, (leadPage + 1) * PAGE_SIZE);
  const totalPages = Math.ceil(filteredLeads.length / PAGE_SIZE);

  const exportLeads = async () => {
    try {
      const params = new URLSearchParams();
      if (leadFilters.status) params.set("status", leadFilters.status);
      if (leadFilters.search) params.set("search", leadFilters.search);
      const token = getToken();
      const headers = token ? { Authorization: `Bearer ${token}` } : {};

      const res = await fetch(`${API}/campaigns/${campaign.id}/leads/export?${params}`, { headers });
      if (!res.ok) throw new Error("Export failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${currentCampaign.name.replace(/\s+/g, "-").toLowerCase()}-leads.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert("Failed to export leads: " + err.message);
    }
  };

  const deleteSelectedLeads = async () => {
    if (!confirm(`Are you sure you want to delete ${selectedLeads.size} selected leads?`)) return;
    try {
      await api("DELETE", `/campaigns/${campaign.id}/leads`, { lead_ids: Array.from(selectedLeads) });
      setSelectedLeads(new Set());
      loadLeads();
    } catch (err) {
      alert("Failed to delete leads: " + err.message);
    }
  };

  const deleteLead = async (leadId) => {
    if (!confirm("Delete this lead?")) return;
    await api("DELETE", `/campaigns/${campaign.id}/leads/${leadId}`);
    loadLeads();
  };

  const handleSettingsSaved = async () => {
    const updated = await api("GET", `/campaigns/${campaign.id}`);
    setCurrentCampaign(updated);
  };

  const handleBack = () => {
    window.history.replaceState(null, "", window.location.pathname);
    onBack();
  };

  return (
    <div>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-6 border-b border-slate-100">
        <div className="flex flex-col gap-1">
          {/* Breadcrumbs */}
          <button onClick={onBack} className="inline-flex items-center gap-1.5 text-[10px] font-bold text-slate-400 hover:text-indigo-600 transition-colors uppercase tracking-wider bg-transparent border-none cursor-pointer w-fit">
            <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
            Back to Campaigns
          </button>

          <div className="flex items-center gap-3 mt-1">
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">{currentCampaign.name}</h1>
            <StatusBadge status={currentCampaign.status} />
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            size="sm"
            variant="secondary"
            className="text-xs font-semibold border-slate-200 shadow-sm"
            onClick={toggleStatus}
          >
            {currentCampaign.status === "ACTIVE" ? "⏸ Pause Outreach" : "▶ Activate Outreach"}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="text-xs font-semibold border-slate-200 shadow-sm"
            onClick={() => setTab("settings")}
          >
            ⚙ Settings
          </Button>
        </div>
      </div>

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-4 gap-4 mb-6">
          <Card className="p-4 bg-gradient-to-tr from-indigo-50/50 to-indigo-50/10 border-indigo-100/50 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center shadow-md shadow-indigo-100/40">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Total Leads</p>
              <p className="text-2xl font-extrabold text-slate-900 mt-0.5">{stats.total_leads}</p>
            </div>
          </Card>

          <Card className="p-4 bg-gradient-to-tr from-sky-50/50 to-sky-50/10 border-sky-100/50 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-sky-600 text-white flex items-center justify-center shadow-md shadow-sky-100/40">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5" /></svg>
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Contacted</p>
              <p className="text-2xl font-extrabold text-slate-900 mt-0.5">{stats.contacted}</p>
            </div>
          </Card>

          <Card className="p-4 bg-gradient-to-tr from-emerald-50/50 to-emerald-50/10 border-emerald-100/50 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-emerald-600 text-white flex items-center justify-center shadow-md shadow-emerald-100/40">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M16 15v-1a4 4 0 00-4-4H8m0 0l3 3m-3-3l3-3m9 14V5a2 2 0 00-2-2H6a2 2 0 00-2 2v16" /></svg>
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Replied</p>
              <p className="text-xl font-extrabold text-slate-900 mt-0.5">
                {stats.replied} <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-md border border-emerald-100/60 ml-1.5">({stats.reply_rate}%)</span>
              </p>
            </div>
          </Card>

          <Card className="p-4 bg-gradient-to-tr from-violet-50/50 to-violet-50/10 border-violet-100/50 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-violet-600 text-white flex items-center justify-center shadow-md shadow-violet-150/40">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
            </div>
            <div>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Emails Sent</p>
              <p className="text-2xl font-extrabold text-slate-900 mt-0.5">{stats.emails_sent}</p>
            </div>
          </Card>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-slate-100/80 p-1.5 rounded-xl border border-slate-200/40 w-fit">
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-lg text-xs font-bold uppercase tracking-wider transition-all duration-150 cursor-pointer ${tab === t
              ? "bg-slate-900 text-white shadow-sm shadow-slate-900/10"
              : "text-slate-500 hover:text-slate-900 hover:bg-slate-50/80"
              }`}
          >
            {t === "inboxes" ? "Inbox" : t}
          </button>
        ))}
      </div>

      {/* Leads tab */}
      {tab === "leads" && (
        <div>
          <LeadStatusOverview campaignId={campaign.id} leads={leads} />
          <LeadFilterBar
            filters={leadFilters}
            onFiltersChange={setLeadFilters}
            onExport={exportLeads}
            totalLeads={leads.length}
            filteredCount={filteredLeads.length}
          />
          {selectedLeads.size > 0 && filteredLeads.length > pagedLeads.length && (
            <div className="bg-indigo-50 border border-indigo-100 p-3 rounded-xl text-xs font-semibold text-indigo-800 flex items-center justify-between mb-4 animate-fade-in">
              <span>
                {selectedLeads.size === filteredLeads.length 
                  ? `All ${filteredLeads.length} leads in this campaign are selected.` 
                  : `${selectedLeads.size} leads on this page are selected.`
                }
              </span>
              {selectedLeads.size !== filteredLeads.length ? (
                <button 
                  type="button"
                  onClick={() => setSelectedLeads(new Set(filteredLeads.map(l => l.id)))}
                  className="underline text-indigo-600 hover:text-indigo-900 cursor-pointer bg-transparent border-none font-bold outline-none"
                >
                  Select all {filteredLeads.length} leads in this campaign
                </button>
              ) : (
                <button 
                  type="button"
                  onClick={() => setSelectedLeads(new Set())}
                  className="underline text-indigo-600 hover:text-indigo-900 cursor-pointer bg-transparent border-none font-bold outline-none"
                >
                  Clear selection
                </button>
              )}
            </div>
          )}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm font-semibold text-slate-600 cursor-pointer">
                <input type="checkbox"
                  checked={selectedLeads.size > 0 && (selectedLeads.size === pagedLeads.length || selectedLeads.size === filteredLeads.length)}
                  onChange={e => {
                    if (e.target.checked) {
                      setSelectedLeads(new Set(pagedLeads.map(l => l.id)));
                    } else {
                      setSelectedLeads(new Set());
                    }
                  }}
                  className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 w-4 h-4 cursor-pointer"
                />
                Select Page
              </label>
              {selectedLeads.size > 0 && (
                <Button size="sm" variant="danger" onClick={deleteSelectedLeads}>
                  Delete ({selectedLeads.size})
                </Button>
              )}
            </div>
            <Button size="sm" onClick={() => setShowImport(true)}>Import CSV</Button>
          </div>
          {showImport && (
            <ImportLeads
              campaignId={campaign.id}
              onDone={() => {
                setShowImport(false);
                loadLeads();
                api("GET", `/campaigns/${campaign.id}/leads/fields`).then(d => setAvailableFields(d.fields || [])).catch(() => { });
              }}
            />
          )}

          {/* Leads table */}
          <div className="overflow-x-auto rounded-xl border border-gray-200">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide w-10">#</th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Email</th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Company</th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Website</th>
                  {allCustomKeys.map(k => (
                    <th key={k} className="text-left px-3 py-2.5 text-xs font-semibold text-blue-500 uppercase tracking-wide whitespace-nowrap">
                      {k.replace(/_/g, " ")}
                    </th>
                  ))}
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">Status</th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide w-16">Step</th>
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wide w-10">🗑</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {pagedLeads.length === 0 && (
                  <tr><td colSpan={8 + allCustomKeys.length} className="px-3 py-8 text-center text-gray-400 text-sm">
                    {leadFilters.search || leadFilters.status || leadFilters.minStep || leadFilters.maxStep ? "No leads match your filters." : "No leads yet — import a CSV to get started."}
                  </td></tr>
                )}
                {pagedLeads.map((l, idx) => (
                  <tr key={l.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-3 py-2 text-gray-400 text-xs">
                      <input
                        type="checkbox"
                        checked={selectedLeads.has(l.id)}
                        onChange={e => {
                          const newSet = new Set(selectedLeads);
                          if (e.target.checked) newSet.add(l.id);
                          else newSet.delete(l.id);
                          setSelectedLeads(newSet);
                        }}
                      />
                    </td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{l.email}</td>
                    <td className="px-3 py-2 font-medium text-gray-900 whitespace-nowrap">
                      {[l.first_name, l.last_name].filter(Boolean).join(" ") || <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{l.company || <span className="text-gray-300">—</span>}</td>
                    <td className="px-3 py-2 text-gray-600 whitespace-nowrap max-w-[160px] truncate">
                      {l.website ? <a href={l.website} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline truncate block">{l.website}</a> : <span className="text-gray-300">—</span>}
                    </td>
                    {allCustomKeys.map(k => (
                      <td key={k} className="px-3 py-2 text-gray-600 whitespace-nowrap max-w-[200px] truncate" title={l.custom_fields?.[k] || ""}>
                        {l.custom_fields?.[k] || <span className="text-gray-300">—</span>}
                      </td>
                    ))}
                    <td className="px-3 py-2">
                      <LeadStatusDropdown
                        lead={l}
                        campaignId={campaign.id}
                        onUpdated={loadLeads}
                      />
                    </td>
                    <td className="px-3 py-2 text-gray-500 text-xs">{l.current_step || 0}</td>
                    <td className="px-3 py-2">
                      <button onClick={() => deleteLead(l.id)} className="text-red-400 hover:text-red-600 text-xs" title="Delete lead">
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-xs text-gray-500">
                Showing {leadPage * PAGE_SIZE + 1}–{Math.min((leadPage + 1) * PAGE_SIZE, filteredLeads.length)} of {filteredLeads.length}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" disabled={leadPage === 0} onClick={() => setLeadPage(p => p - 1)}>← Prev</Button>
                <span className="text-xs text-gray-500 self-center">Page {leadPage + 1} of {totalPages}</span>
                <Button size="sm" variant="secondary" disabled={leadPage >= totalPages - 1} onClick={() => setLeadPage(p => p + 1)}>Next →</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sequence tab */}
      {tab === "sequence" && (
        <SequenceVariantsManager
          campaignId={campaign.id}
          sequences={sequences}
          leads={leads}
          availableFields={availableFields}
          onSaved={() => api("GET", `/campaigns/${campaign.id}/sequences`).then(setSequences)}
        />
      )}

      {tab === "activity" && (
        <ActivityFeed campaignId={campaign.id} />
      )}

      {/* Inboxes tab */}
      {tab === "inboxes" && (
        <CampaignInboxManager campaignId={campaign.id} />
      )}

      {/* Stats tab */}
      {tab === "stats" && (
        <AnalyticsDashboard campaignId={campaign.id} />
      )}

      {/* Settings tab */}
      {tab === "settings" && (
        <CampaignSettingsTab campaign={currentCampaign} onSaved={handleSettingsSaved} onDeleted={onBack} />
      )}
    </div>
  );
}

// ─── Import Leads ─────────────────────────────────────────────────────────────
function ImportLeads({ campaignId, onDone }) {
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [importError, setImportError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!file) return;
    setLoading(true);
    setImportError("");
    setResult(null);
    const form = new FormData();
    form.append("file", file);
    try {
      const res = await fetch(`${API}/campaigns/${campaignId}/leads/import`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });
      const data = await res.json();
      if (!res.ok) {
        setImportError(data.detail || "Import failed. Please check your CSV format.");
      } else {
        setResult(data);
      }
    } catch (err) {
      setImportError("Network error — could not reach the server.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="p-5 mb-5 border-indigo-100 bg-indigo-50/10">
      <h3 className="font-bold text-slate-900 text-sm mb-1.5">Import Leads from CSV</h3>
      <p className="text-xs text-slate-500 mb-4 leading-relaxed">
        Required column: <code className="bg-slate-100 px-1 rounded text-slate-800 font-mono text-[10px]">email</code>. Optional: <code className="bg-slate-100 px-1 rounded text-slate-800 font-mono text-[10px]">first_name, last_name, company, website</code>. Other columns map automatically to custom tags.
      </p>
      <div className="flex flex-wrap gap-2.5 items-center">
        <label className="inline-flex items-center gap-2 px-3 py-2 border border-slate-200 rounded-lg bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer shadow-sm active:scale-[0.98] transition-all">
          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
          {file ? file.name : "Choose CSV File"}
          <input type="file" accept=".csv" onChange={e => setFile(e.target.files[0])} className="hidden" />
        </label>
        <Button size="sm" onClick={submit} disabled={!file || loading}>{loading ? "Importing..." : "Start Import"}</Button>
        <Button size="sm" variant="secondary" onClick={onDone}>Cancel</Button>
      </div>
      {importError && (
        <div className="mt-3 text-sm bg-red-50 text-red-700 p-3 rounded-lg">
          ✗ {importError}
        </div>
      )}
      {result && (
        <div className="mt-3 text-sm bg-green-50 text-green-800 p-3 rounded-lg flex items-center justify-between">
          <span>
            ✓ <strong>{result.imported}</strong> imported
            {result.duplicates > 0 && <> · <strong>{result.duplicates}</strong> duplicates skipped</>}
            {result.errors > 0 && <> · <strong>{result.errors}</strong> errors</>}
          </span>
          <Button size="sm" variant="ghost" onClick={onDone} className="ml-3">Done</Button>
        </div>
      )}
    </Card>
  );
}

const rebalanceWeights = (changedId, newWeight, list) => {
  if (list.length <= 1) {
    return list.map(item => ({ ...item, variant_weight: 100 }));
  }

  const targetWeight = Math.min(100, Math.max(0, newWeight));
  const otherItems = list.filter(item => item.id !== changedId);
  const otherSum = otherItems.reduce((sum, item) => sum + (item.variant_weight || 0), 0);
  const remaining = 100 - targetWeight;

  let updatedOthers;
  if (otherSum > 0) {
    updatedOthers = otherItems.map(item => {
      const share = (item.variant_weight || 0) / otherSum;
      return { ...item, variant_weight: Math.round(remaining * share) };
    });
  } else {
    const equalShare = Math.floor(remaining / otherItems.length);
    updatedOthers = otherItems.map(item => ({ ...item, variant_weight: equalShare }));
  }

  const currentSum = targetWeight + updatedOthers.reduce((sum, item) => sum + item.variant_weight, 0);
  const diff = 100 - currentSum;
  if (diff !== 0 && updatedOthers.length > 0) {
    let maxIdx = 0;
    for (let i = 1; i < updatedOthers.length; i++) {
      if (updatedOthers[i].variant_weight > updatedOthers[maxIdx].variant_weight) {
        maxIdx = i;
      }
    }
    updatedOthers[maxIdx].variant_weight += diff;
  }

  return list.map(item => {
    if (item.id === changedId) {
      return { ...item, variant_weight: targetWeight };
    }
    const updated = updatedOthers.find(o => o.id === item.id);
    return { ...item, variant_weight: updated ? updated.variant_weight : 0 };
  });
};

// ─── Sequence Variants Manager ─────────────────────────────────────────────────
function SequenceVariantsManager({ campaignId, sequences, leads, availableFields, onSaved }) {
  const [allSequences, setAllSequences] = useState([]);
  const [activeSeq, setActiveSeq] = useState(null);
  const [steps, setSteps] = useState([]);
  const [seqName, setSeqName] = useState("Main Sequence");
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showCreateVariant, setShowCreateVariant] = useState(false);
  const [attachments, setAttachments] = useState({});
  const [uploadingAtt, setUploadingAtt] = useState({});
  const [variantAnalytics, setVariantAnalytics] = useState([]);

  const loadAnalytics = useCallback(async () => {
    try {
      const data = await api("GET", `/campaigns/${campaignId}/analytics/variants`);
      setVariantAnalytics(data);
    } catch (e) {
      console.error(e);
    }
  }, [campaignId]);

  useEffect(() => {
    if (sequences.length > 0) {
      setAllSequences(sequences);
      const active = sequences.find(s => s.is_main_variant) || sequences[0];
      setActiveSeq(active);
      setSeqName(active.name);
      setSteps(active.steps.map(s => ({ ...s })));
      loadAttachments();
      loadAnalytics();
    }
  }, [sequences, loadAnalytics]);

  const handleWeightChange = (seqId, newWeight) => {
    const updatedSeqs = rebalanceWeights(seqId, newWeight, allSequences);
    setAllSequences(updatedSeqs);
    const updatedActive = updatedSeqs.find(s => s.id === activeSeq?.id);
    if (updatedActive) {
      setActiveSeq(updatedActive);
    }
  };

  const loadAttachments = async () => {
    const atts = await api("GET", `/campaigns/${campaignId}/attachments`);
    const grouped = {};
    atts.forEach(a => {
      if (a.sequence_step_id) {
        grouped[a.sequence_step_id] = grouped[a.sequence_step_id] || [];
        grouped[a.sequence_step_id].push(a);
      }
    });
    setAttachments(grouped);
  };

  const addStep = () => {
    setSteps([...steps, {
      step_number: steps.length + 1,
      delay_days_min: steps.length > 0 ? 3 : 0,
      delay_days_max: steps.length > 0 ? 5 : 0,
      subject: "",
      body: "",
      is_plain_text: true,
    }]);
  };

  const updateStep = (i, field, value) => {
    setSteps(steps.map((s, idx) => idx === i ? { ...s, [field]: value } : s));
  };

  const removeStep = (i) => {
    setSteps(steps.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step_number: idx + 1 })));
  };

  const save = async () => {
    setLoading(true);
    try {
      const payload = {
        name: seqName,
        steps,
        variant_weight: activeSeq?.variant_weight,
        is_main_variant: activeSeq?.is_main_variant
      };
      await api("PUT", `/campaigns/${campaignId}/sequences/${activeSeq.id}`, payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved();
    } finally {
      setLoading(false);
    }
  };

  const createVariant = async (variantName) => {
    const mainSeq = allSequences.find(s => s.is_main_variant) || allSequences[0];
    const variantWeight = Math.floor(100 / (allSequences.length + 1));
    const stepsToUse = mainSeq?.steps ? mainSeq.steps.map(s => ({
      step_number: s.step_number,
      delay_days_min: s.delay_days_min,
      delay_days_max: s.delay_days_max,
      subject: "",
      body: "",
      is_plain_text: true,
    })) : [];

    await api("POST", `/campaigns/${campaignId}/sequences`, {
      name: variantName,
      steps: stepsToUse,
      variant_weight: variantWeight,
    });
    setShowCreateVariant(false);
    onSaved();
  };

  const setMainVariant = async (seqId) => {
    await api("PATCH", `/campaigns/${campaignId}/sequences/${seqId}/set-active`);
    onSaved();
  };

  const handleVariantChange = (seq) => {
    setActiveSeq(seq);
    setSeqName(seq.name);
    setSteps(seq.steps.map(s => ({ ...s })));
  };

  const uploadAttachment = async (stepId, file) => {
    setUploadingAtt({ ...uploadingAtt, [stepId]: true });
    const form = new FormData();
    form.append("file", file);

    try {
      const res = await fetch(`${API}/campaigns/${campaignId}/attachments?sequence_step_id=${stepId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });
      if (res.ok) {
        loadAttachments();
      }
    } catch (e) {
      alert("Upload failed");
    } finally {
      setUploadingAtt({ ...uploadingAtt, [stepId]: false });
    }
  };

  const deleteAttachment = async (attId) => {
    await api("DELETE", `/campaigns/${campaignId}/attachments/${attId}`);
    loadAttachments();
  };

  return (
    <div>
      {showPreview && (
        <SequencePreview steps={steps} leads={leads} onClose={() => setShowPreview(false)} />
      )}

      <div className="flex flex-col gap-4 mb-4 p-4 bg-slate-50 rounded-xl border border-slate-100">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Select Variant</span>
            <select
              value={activeSeq?.id || ""}
              onChange={e => handleVariantChange(allSequences.find(s => s.id === parseInt(e.target.value)))}
              className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm font-semibold bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            >
              {allSequences.map((seq) => (
                <option key={seq.id} value={seq.id}>
                  {seq.name} {seq.is_main_variant ? "⭐ (Main)" : `(${seq.variant_weight || 100}%)`}
                </option>
              ))}
            </select>
            <Button size="sm" variant="secondary" onClick={() => setShowCreateVariant(true)}>+ Add Variant</Button>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowPreview(true)}>👁 Preview Emails</Button>
            <Button size="sm" variant="secondary" onClick={addStep}>+ Add Follow-up Step</Button>
            <Button size="sm" onClick={save} disabled={loading}>{saved ? "✓ Saved" : loading ? "Saving..." : "Save Sequence"}</Button>
          </div>
        </div>

        {activeSeq && (
          <div className="flex flex-wrap items-center gap-6 pt-3 border-t border-slate-200/60">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500">Variant Name:</span>
              <input
                type="text"
                value={seqName}
                onChange={e => {
                  setSeqName(e.target.value);
                  setAllSequences(allSequences.map(s => s.id === activeSeq.id ? { ...s, name: e.target.value } : s));
                }}
                placeholder="e.g. Variant A"
                className="border border-slate-200 rounded-lg px-3 py-1 text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 w-44"
              />
            </div>

            {!activeSeq.is_main_variant && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-500">Traffic Allocation:</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={activeSeq.variant_weight ?? 100}
                    onChange={e => {
                      const val = Math.min(100, Math.max(0, parseInt(e.target.value) || 0));
                      setAllSequences(allSequences.map(s => s.id === activeSeq.id ? { ...s, variant_weight: val } : s));
                      setActiveSeq({ ...activeSeq, variant_weight: val });
                    }}
                    className="w-16 border border-slate-200 rounded-lg px-2.5 py-1 text-sm bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-center font-semibold"
                  />
                  <span className="text-xs font-semibold text-slate-400">%</span>
                </div>

                <Button
                  size="sm"
                  variant="secondary"
                  className="text-xs border-indigo-100 text-indigo-700 hover:bg-indigo-50"
                  onClick={() => setMainVariant(activeSeq.id)}
                >
                  ⭐ Make Main
                </Button>

                <Button
                  size="sm"
                  variant="danger"
                  className="text-xs"
                  onClick={async () => {
                    if (confirm(`Are you sure you want to delete this variant sequence: "${activeSeq.name}"? Leads will be reassigned to the main sequence.`)) {
                      await api("DELETE", `/campaigns/${campaignId}/sequences/${activeSeq.id}`);
                      onSaved();
                    }
                  }}
                >
                  Delete Variant
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {allSequences.length > 1 && (
        <div className="mb-6 p-4 bg-slate-50 rounded-xl border border-slate-200/80 flex flex-col gap-4">
          <div>
            <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider">A/B Traffic Splitter & Performance Comparison</h4>
            <p className="text-[11px] text-slate-400 mt-0.5">Control how new leads are distributed across sequence copy variants. Total must equal 100%.</p>
          </div>

          <div className="space-y-3.5">
            {allSequences.map(seq => {
              const ana = variantAnalytics.find(v => v.variant_id === seq.id);
              const mainAna = variantAnalytics.find(v => v.is_main);
              const isWinner = mainAna && !seq.is_main_variant && ana && ana.reply_rate >= 2 * mainAna.reply_rate && ana.emails_sent >= 5;

              return (
                <div key={seq.id} className="flex items-center justify-between gap-4 bg-white p-3 rounded-lg border border-slate-100 shadow-sm">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="font-bold text-slate-800 text-xs truncate">{seq.name}</span>
                      {seq.is_main_variant && <Badge color="indigo">Control (Main)</Badge>}
                      {isWinner && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-100 animate-bounce">🏆 Winner</span>}
                    </div>
                    {ana && (
                      <div className="flex items-center gap-4 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                        <span>Sent: <strong className="text-slate-700">{ana.emails_sent}</strong></span>
                        <span>Replies: <strong className="text-slate-700">{ana.replies}</strong> (<strong className="text-emerald-600">{ana.reply_rate}%</strong>)</span>
                        <span>Opens: <strong className="text-slate-700">{ana.opens}</strong> (<strong className="text-sky-600">{ana.open_rate}%</strong>)</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={seq.variant_weight ?? 100}
                      onChange={e => handleWeightChange(seq.id, parseInt(e.target.value) || 0)}
                      className="w-32 accent-indigo-600 cursor-pointer h-1 bg-slate-100 rounded-lg appearance-none"
                    />
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={seq.variant_weight ?? 100}
                        onChange={e => handleWeightChange(seq.id, parseInt(e.target.value) || 0)}
                        className="w-14 border border-slate-200 rounded-lg px-1.5 py-0.5 text-xs bg-slate-50 text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 text-center font-bold"
                      />
                      <span className="text-xs font-bold text-slate-400">%</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex justify-between items-center border-t border-slate-200/60 pt-3">
            <span className="text-[10px] font-bold text-slate-400 uppercase">
              Total Allocation: <strong className={allSequences.reduce((s, x) => s + (x.variant_weight || 0), 0) === 100 ? "text-emerald-600" : "text-rose-600"}>{allSequences.reduce((s, x) => s + (x.variant_weight || 0), 0)}%</strong>
            </span>
            <Button size="sm" variant="secondary" className="text-xs font-semibold" onClick={async () => {
              setLoading(true);
              try {
                for (const seq of allSequences) {
                  await api("PATCH", `/campaigns/${campaignId}/sequences/${seq.id}`, { variant_weight: seq.variant_weight });
                }
                setSaved(true);
                setTimeout(() => setSaved(false), 2000);
                onSaved();
                loadAnalytics();
              } catch (err) {
                alert("Failed to save weights: " + err.message);
              } finally {
                setLoading(false);
              }
            }}>
              Save Traffic Weights
            </Button>
          </div>
        </div>
      )}

      {showCreateVariant && createPortal(
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 border border-slate-100">
            <h3 className="font-bold text-slate-950 text-base mb-1">Create A/B Email Variant</h3>
            <p className="text-xs text-slate-400 mb-4">Introduce a new copy variant to test deliverability & response.</p>
            <input
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
              placeholder="Variant name (e.g. 'Founder Subject Line B')"
              onKeyDown={e => {
                if (e.key === "Enter" && e.target.value) {
                  createVariant(e.target.value);
                }
              }}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setShowCreateVariant(false)}>Cancel</Button>
              <Button size="sm" onClick={() => {
                const inputEl = document.querySelector('input[placeholder="Variant name (e.g. \'Founder Subject Line B\')"]');
                if (inputEl && inputEl.value) {
                  createVariant(inputEl.value);
                }
              }}>Create Variant</Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {availableFields.length > 0 && (
        <div className="mb-4 p-3.5 bg-slate-50 rounded-xl border border-slate-200/60 flex flex-col gap-2">
          <p className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
            <svg className="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            Available variables from your CSV — type <code className="bg-slate-200/60 px-1 rounded text-slate-700 text-[10px] font-mono">{"{{"}</code> to autocomplete inside any text editor
          </p>
          <div className="flex flex-wrap gap-1.5">
            {availableFields.map(f => (
              <span key={f} className="px-2 py-0.5 bg-white border border-slate-200 text-slate-600 rounded-md text-[10px] font-mono shadow-sm cursor-help hover:text-indigo-600 hover:border-indigo-300 transition-colors" title={`Insert {{${f}}}`}>{`{{${f}}}`}</span>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {steps.map((step, i) => {
          const stepAttachments = attachments[step.id] || [];
          return (
            <Card key={i} className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className="w-7 h-7 bg-gray-900 text-white rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0">{step.step_number}</span>
                  {i === 0 ? (
                    <span className="text-sm text-gray-500">Send immediately within window</span>
                  ) : (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-gray-500">Delay:</span>
                      <input type="number" min={0} className="border border-gray-300 rounded px-2 py-1 w-14 text-sm" value={step.delay_days_min} onChange={e => updateStep(i, "delay_days_min", +e.target.value)} />
                      <span className="text-gray-400">–</span>
                      <input type="number" min={0} className="border border-gray-300 rounded px-2 py-1 w-14 text-sm" value={step.delay_days_max} onChange={e => updateStep(i, "delay_days_max", +e.target.value)} />
                      <span className="text-gray-500">days (random)</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={step.is_plain_text}
                      onChange={e => {
                        const isPlain = e.target.checked;
                        const newBody = isPlain ? htmlToPlainText(step.body) : plainTextToHtml(step.body);
                        setSteps(steps.map((s, idx) => idx === i ? { ...s, is_plain_text: isPlain, body: newBody } : s));
                      }}
                    />
                    Plain text
                  </label>
                  {steps.length > 1 && (
                    <Button size="sm" variant="ghost" onClick={() => removeStep(i)}>✕</Button>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-3">
                <div className="relative">
                  <label className="text-xs font-medium text-gray-500 mb-1 block">Subject</label>
                  <div className="relative">
                    <SubjectInput
                      value={step.subject}
                      onChange={v => updateStep(i, "subject", v)}
                      availableFields={availableFields}
                      placeholder={`Subject line — type {{ for variables`}
                    />
                  </div>
                </div>
                <VarTextarea
                  label="Body"
                  value={step.body}
                  onChange={v => updateStep(i, "body", v)}
                  availableFields={availableFields}
                  placeholder={`Email body — type {{ to insert a variable`}
                  rows={8}
                  isPlainText={step.is_plain_text}
                />

                {/* Attachments */}
                <div className="bg-slate-50/50 rounded-xl border border-slate-100 p-4 mt-3">
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider block mb-2">Attachments</span>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {stepAttachments.length === 0 && (
                      <span className="text-xs text-slate-400">No attachments for this email step yet.</span>
                    )}
                    {stepAttachments.map(att => (
                      <div key={att.id} className="flex items-center gap-2 px-2.5 py-1 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-700 shadow-sm">
                        <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                        <span className="truncate max-w-[150px]">{att.filename}</span>
                        <button type="button" onClick={() => deleteAttachment(att.id)} className="text-slate-400 hover:text-rose-600 transition-colors text-xs font-bold px-1">✕</button>
                      </div>
                    ))}
                  </div>
                  {!step.id ? (
                    <div className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2 border border-amber-100 font-semibold inline-flex items-center gap-1.5 mt-1.5">
                      <span>⚠️ Please click "Save Sequence" first to enable attachments for this step.</span>
                    </div>
                  ) : (
                    <label className="inline-flex items-center gap-2 px-3 py-1.5 border border-slate-200 rounded-lg bg-white text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer shadow-sm active:scale-[0.98] transition-all">
                      <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 4v16m8-8H4" /></svg>
                      Upload File
                      <input type="file"
                        onChange={e => {
                          if (e.target.files[0]) {
                            uploadAttachment(step.id, e.target.files[0]);
                          }
                        }}
                        disabled={uploadingAtt[step.id]}
                        className="hidden"
                      />
                    </label>
                  )}
                  {uploadingAtt[step.id] && <span className="text-xs text-indigo-600 font-semibold ml-3 animate-pulse">Uploading file...</span>}
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// Single-line subject input with variable autocomplete
function SubjectInput({ value, onChange, availableFields, placeholder }) {
  const [suggestion, setSuggestion] = useState(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [input, setInput] = useState(null);

  const handleChange = (e) => {
    const val = e.target.value;
    onChange(val);
    const cursor = e.target.selectionStart;
    const textBefore = val.slice(0, cursor);
    const match = textBefore.match(/\{\{([a-zA-Z0-9_]*)$/);
    if (match) {
      const query = match[1].toLowerCase();
      const filtered = availableFields.filter(f => f.toLowerCase().includes(query));
      if (filtered.length > 0) { setSuggestion({ fields: filtered, query, cursorPos: cursor }); setSelectedIdx(0); }
      else setSuggestion(null);
    } else setSuggestion(null);
  };

  const insertVariable = (field) => {
    if (!input || !suggestion) return;
    const val = input.value;
    const before = val.slice(0, suggestion.cursorPos);
    const matchIdx = before.lastIndexOf("{{");
    const newVal = val.slice(0, matchIdx) + `{{${field}}}` + val.slice(suggestion.cursorPos);
    onChange(newVal);
    setSuggestion(null);
    setTimeout(() => { input.focus(); const pos = matchIdx + field.length + 4; input.setSelectionRange(pos, pos); }, 0);
  };

  const handleKeyDown = (e) => {
    if (!suggestion) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, suggestion.fields.length - 1)); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insertVariable(suggestion.fields[selectedIdx]); }
    if (e.key === "Escape") setSuggestion(null);
  };

  return (
    <div className="relative">
      <input
        ref={node => setInput(node)}
        type="text"
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setSuggestion(null), 150)}
        placeholder={placeholder}
      />
      {suggestion && (
        <div className="absolute z-50 bg-white border border-gray-200 rounded-lg shadow-xl w-64 max-h-48 overflow-y-auto" style={{ top: "100%", left: 0, marginTop: 2 }}>
          <div className="px-3 py-1.5 text-xs text-gray-400 border-b border-gray-100">Variables — Tab/Enter to insert</div>
          {suggestion.fields.map((f, i) => (
            <button key={f} type="button" onMouseDown={() => insertVariable(f)}
              className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${i === selectedIdx ? "bg-gray-900 text-white" : "hover:bg-gray-50 text-gray-700"}`}>
              <span className="font-mono text-xs opacity-60">{"{{"}</span>
              <span className="font-medium">{f}</span>
              <span className="font-mono text-xs opacity-60">{"}}"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CampaignInboxManager({ campaignId }) {
  const [assigned, setAssigned] = useState([]);
  const [available, setAvailable] = useState([]);
  const [loading, setLoading] = useState(true);
  const [conflict, setConflict] = useState(null);
  // conflict = { accountId, accountEmail, otherCampaignName, otherCampaignId }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [assignedData, allData] = await Promise.all([
        api("GET", `/campaigns/${campaignId}/email-accounts`),
        api("GET", "/email-accounts/availability"),
      ]);
      setAssigned(assignedData);
      setAvailable(allData);
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => { load(); }, [load]);

  const assignedIds = new Set(assigned.map(a => a.account_id));

  const handleAssign = async (accountId, accountEmail, force = false) => {
    try {
      await api(
        "POST",
        `/campaigns/${campaignId}/email-accounts/${accountId}${force ? "?force=true" : ""}`
      );
      setConflict(null);
      load();
    } catch (err) {
      if (err.message.startsWith("CONFLICT:")) {
        const parts = err.message.split(":");
        setConflict({
          accountId,
          accountEmail,
          otherCampaignName: parts[1],
          otherCampaignId: parts[2],
        });
      } else {
        alert(err.message);
      }
    }
  };

  const handleUnassign = async (accountId) => {
    if (!confirm("Remove this account from the campaign? Scheduled emails using it won't be affected until the next scheduling run.")) return;
    await api("DELETE", `/campaigns/${campaignId}/email-accounts/${accountId}`);
    load();
  };

  const HEALTH_META = {
    HEALTHY: { color: "bg-green-100 text-green-800", dot: "bg-green-500", label: "Healthy" },
    WARMING: { color: "bg-blue-100 text-blue-800", dot: "bg-blue-400", label: "Warming up" },
    THROTTLED: { color: "bg-yellow-100 text-yellow-800", dot: "bg-yellow-500", label: "Throttled" },
    PAUSED: { color: "bg-red-100 text-red-800", dot: "bg-red-500", label: "Paused" },
  };

  const unassignedAccounts = available.filter(a => !assignedIds.has(a.id));

  if (loading) return <div className="text-gray-400 text-sm py-8 text-center">Loading accounts...</div>;

  return (
    <div className="flex flex-col gap-6">

      {/* Conflict modal */}
      {conflict && createPortal(
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="text-center mb-4">
              <div className="text-3xl mb-2">⚠️</div>
              <h3 className="font-semibold text-gray-900 text-lg">Account Already In Use</h3>
            </div>
            <p className="text-sm text-gray-600 text-center mb-6">
              <span className="font-medium text-gray-900">{conflict.accountEmail}</span> is currently
              assigned to campaign <span className="font-medium text-gray-900">"{conflict.otherCampaignName}"</span>.
              <br /><br />
              An account can only be active in <strong>one campaign at a time</strong>. Do you want to
              move it to this campaign instead?
            </p>
            <div className="flex gap-3">
              <Button
                variant="danger"
                className="flex-1 justify-center"
                onClick={() => handleAssign(conflict.accountId, conflict.accountEmail, true)}
              >
                Move to this campaign
              </Button>
              <Button
                variant="secondary"
                className="flex-1 justify-center"
                onClick={() => setConflict(null)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Assigned accounts */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-900">
            Assigned Inboxes
            <span className="ml-2 text-sm font-normal text-gray-400">
              ({assigned.length} account{assigned.length !== 1 ? "s" : ""})
            </span>
          </h3>
          {assigned.length > 1 && (
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-1 rounded-full">
              Load balanced automatically
            </span>
          )}
        </div>

        {assigned.length === 0 ? (
          <div className="border-2 border-dashed border-gray-200 rounded-xl p-8 text-center">
            <p className="text-2xl mb-2">📭</p>
            <p className="text-sm font-medium text-gray-500">No accounts assigned yet</p>
            <p className="text-xs text-gray-400 mt-1">Add accounts from the list below to start sending</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {assigned.map((acct) => {
              const health = HEALTH_META[acct.health_status] || HEALTH_META.HEALTHY;
              const usedPct = Math.round((acct.emails_sent_today / acct.daily_limit) * 100);
              return (
                <div key={acct.account_id} className="border border-gray-200 rounded-xl p-4 bg-white">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      {/* Health dot */}
                      <div className={`w-2.5 h-2.5 rounded-full mt-1.5 flex-shrink-0 ${health.dot}`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-gray-900">{acct.name}</span>
                          <span className="text-xs text-gray-400 font-mono">{acct.email}</span>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${health.color}`}>
                            {health.label}
                            {acct.is_warming_up && ` (day ${acct.warmup_day})`}
                          </span>
                        </div>

                        {/* Daily usage bar */}
                        <div className="mt-2.5">
                          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                            <span>{acct.emails_sent_today} / {acct.daily_limit} sent today</span>
                            <span>{usedPct}%</span>
                          </div>
                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${usedPct >= 90 ? "bg-red-500" :
                                usedPct >= 70 ? "bg-yellow-500" : "bg-green-500"
                                }`}
                              style={{ width: `${Math.min(usedPct, 100)}%` }}
                            />
                          </div>
                        </div>

                        {/* Stats row */}
                        <div className="mt-2 flex gap-4 text-xs text-gray-400">
                          <span>{acct.sends_this_week} sent this week</span>
                          <span>{acct.bounce_rate}% bounce rate</span>
                          {acct.bounce_rate >= 5 && (
                            <span className="text-orange-600 font-medium">
                              ⚠ High bounce rate
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleUnassign(acct.account_id)}
                      className="text-red-400 hover:text-red-600 hover:bg-red-50 flex-shrink-0"
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Capacity summary */}
      {assigned.length > 0 && (
        <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
            Today's Sending Capacity
          </p>
          <div className="grid grid-cols-3 gap-3">
            {[
              ["Total daily limit", assigned.reduce((s, a) => s + a.daily_limit, 0) + " emails"],
              ["Remaining today", assigned.reduce((s, a) => s + Math.max(0, a.daily_limit - a.emails_sent_today), 0) + " emails"],
              ["Accounts active", assigned.filter(a => a.health_status !== "PAUSED").length + " / " + assigned.length],
            ].map(([label, val]) => (
              <div key={label} className="text-center">
                <p className="text-lg font-bold text-gray-900">{val}</p>
                <p className="text-xs text-gray-400 mt-0.5">{label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Available accounts to add */}
      <div>
        <h3 className="font-semibold text-gray-900 mb-3">
          Add Inbox
          <span className="ml-2 text-sm font-normal text-gray-400">
            ({unassignedAccounts.length} available)
          </span>
        </h3>

        {unassignedAccounts.length === 0 && available.length === 0 && (
          <div className="border border-gray-200 rounded-xl p-6 text-center bg-gray-50">
            <p className="text-sm text-gray-500">No email accounts added yet.</p>
            <p className="text-xs text-gray-400 mt-1">
              Go to <strong>Email Accounts</strong> in the sidebar to add one first.
            </p>
          </div>
        )}

        {unassignedAccounts.length === 0 && available.length > 0 && (
          <div className="border border-gray-200 rounded-xl p-6 text-center bg-gray-50">
            <p className="text-sm text-gray-500">All your accounts are already assigned to this campaign.</p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {unassignedAccounts.map((acct) => {
            const health = HEALTH_META[acct.health_status] || HEALTH_META.HEALTHY;
            const isLocked = !acct.is_free;
            return (
              <div
                key={acct.id}
                className={`border rounded-xl p-4 transition-colors ${isLocked ? "border-gray-200 bg-gray-50" : "border-gray-200 bg-white hover:border-gray-300"
                  }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${health.dot}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-gray-900">{acct.name}</span>
                        <span className="text-xs text-gray-400 font-mono truncate">{acct.email}</span>
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${health.color}`}>
                          {health.label}
                        </span>
                        {isLocked && (
                          <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-full">
                            🔒 In use: {acct.assigned_campaign?.name}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex gap-3 text-xs text-gray-400">
                        <span>{acct.emails_sent_today}/{acct.daily_limit} today</span>
                        <span>{acct.sends_this_week} this week</span>
                        {acct.bounce_rate > 0 && <span>{acct.bounce_rate}% bounce</span>}
                      </div>
                    </div>
                  </div>

                  <Button
                    size="sm"
                    variant={isLocked ? "secondary" : "primary"}
                    onClick={() => handleAssign(acct.id, acct.email)}
                  >
                    {isLocked ? "Move here" : "+ Assign"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}


// ─── Provider Presets ───────────────────────────────────────────────────────────
const EMAIL_PROVIDERS = {
  gmail: {
    name: "Gmail",
    smtp_host: "smtp.gmail.com",
    smtp_port: 587,
    smtp_username: "",
    smtp_password_placeholder: "App Password (2FA required)",
    imap_host: "imap.gmail.com",
    imap_port: 993,
  },
  google_workspace: {
    name: "Google Workspace",
    smtp_host: "smtp.gmail.com",
    smtp_port: 587,
    smtp_username: "",
    smtp_password_placeholder: "App Password or OAuth",
    imap_host: "imap.gmail.com",
    imap_port: 993,
  },
  outlook: {
    name: "Outlook / Microsoft 365",
    smtp_host: "smtp.office365.com",
    smtp_port: 587,
    smtp_username: "",
    smtp_password_placeholder: "Password or App Password",
    imap_host: "outlook.office365.com",
    imap_port: 993,
  },
  custom: {
    name: "Custom SMTP",
    smtp_host: "",
    smtp_port: 587,
    smtp_username: "",
    smtp_password_placeholder: "Password",
    imap_host: "",
    imap_port: 993,
  },
};

// ─── Email Accounts ───────────────────────────────────────────────────────────
function EmailAccounts() {
  const [accounts, setAccounts] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "", email: "", smtp_host: "", smtp_port: 587,
    smtp_username: "", smtp_password: "", use_tls: true,
    imap_host: "", imap_port: 993, imap_use_ssl: true, daily_limit: 50,
    is_warming_up: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [testingConnection, setTestingConnection] = useState(false);
  const [selectedIds, setSelectedIds] = useState([]);
  const [showBulkModal, setShowBulkModal] = useState(false);
  const [bulkForm, setBulkForm] = useState({
    daily_limit: 50,
    is_active: true,
    is_warming_up: false,
    update_limit: false,
    update_active: false,
    update_warming: false,
  });

  const load = () => api("GET", "/email-accounts/availability").then(setAccounts);
  useEffect(() => { load(); }, []);

  const handleBulkUpdate = async (e) => {
    e.preventDefault();
    setLoading(true);
    const payload = { account_ids: selectedIds };
    if (bulkForm.update_limit) payload.daily_limit = +bulkForm.daily_limit;
    if (bulkForm.update_active) payload.is_active = bulkForm.is_active;
    if (bulkForm.update_warming) payload.is_warming_up = bulkForm.is_warming_up;

    try {
      await api("PATCH", "/email-accounts/bulk", payload);
      setSelectedIds([]);
      setShowBulkModal(false);
      load();
      alert("Email accounts updated successfully!");
    } catch (err) {
      alert("Bulk update failed: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectAll = (e) => {
    if (e.target.checked) {
      setSelectedIds(accounts.map(a => a.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleOAuth = async (prov) => {
    setShowPicker(false);
    try {
      const { url } = await api("GET", `/email-accounts/${prov}/auth-url`);
      const width = 600;
      const height = 650;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(
        url,
        `Connect ${prov === "google" ? "Google" : "Microsoft"}`,
        `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes`
      );

      const timer = setInterval(() => {
        if (!popup || popup.closed) {
          clearInterval(timer);
          load();
        }
      }, 1000);
    } catch (err) {
      alert(`OAuth initialization failed: ${err.message}`);
    }
  };

  const getDomainPresets = (email) => {
    if (!email || !email.includes("@")) return null;
    const domain = email.split("@")[1].toLowerCase();

    const presets = {
      "gmail.com": { smtp_host: "smtp.gmail.com", smtp_port: 587, imap_host: "imap.gmail.com", imap_port: 993 },
      "googlemail.com": { smtp_host: "smtp.gmail.com", smtp_port: 587, imap_host: "imap.gmail.com", imap_port: 993 },
      "outlook.com": { smtp_host: "smtp.office365.com", smtp_port: 587, imap_host: "outlook.office365.com", imap_port: 993 },
      "hotmail.com": { smtp_host: "smtp.office365.com", smtp_port: 587, imap_host: "outlook.office365.com", imap_port: 993 },
      "live.com": { smtp_host: "smtp.office365.com", smtp_port: 587, imap_host: "outlook.office365.com", imap_port: 993 },
      "zoho.com": { smtp_host: "smtp.zoho.com", smtp_port: 465, imap_host: "imap.zoho.com", imap_port: 993 },
      "yahoo.com": { smtp_host: "smtp.mail.yahoo.com", smtp_port: 587, imap_host: "imap.mail.yahoo.com", imap_port: 993 },
      "ymail.com": { smtp_host: "smtp.mail.yahoo.com", smtp_port: 587, imap_host: "imap.mail.yahoo.com", imap_port: 993 },
    };
    return presets[domain] || null;
  };

  const handleEmailChange = (e) => {
    const val = e.target.value;
    const presets = getDomainPresets(val);

    setForm(prev => {
      const updated = { ...prev, email: val };
      if (!prev.name && val.includes("@")) {
        const localPart = val.split("@")[0];
        updated.name = localPart.charAt(0).toUpperCase() + localPart.slice(1);
      }
      if (!prev.smtp_username || prev.smtp_username === prev.email) {
        updated.smtp_username = val;
      }
      if (presets) {
        updated.smtp_host = presets.smtp_host;
        updated.smtp_port = presets.smtp_port;
        updated.imap_host = presets.imap_host;
        updated.imap_port = presets.imap_port;
      }
      return updated;
    });
  };

  const testConnection = async () => {
    setTestingConnection(true);
    try {
      await api("POST", "/email-accounts/test-connection", form);
      alert("Connection successful!");
    } catch (err) {
      alert(`Connection failed: ${err.message}`);
    } finally {
      setTestingConnection(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await api("POST", "/email-accounts", form);
      setShowForm(false);
      setForm({
        name: "", email: "", smtp_host: "", smtp_port: 587,
        smtp_username: "", smtp_password: "", use_tls: true,
        imap_host: "", imap_port: 993, imap_use_ssl: true, daily_limit: 50,
        is_warming_up: false,
      });
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Email Accounts</h2>
        <Button onClick={() => setShowPicker(true)}>+ Add Account</Button>
      </div>

      {showPicker && createPortal(
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 border border-slate-100">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-100">
              <h3 className="font-bold text-slate-900 text-base">Connect Email Account</h3>
              <button onClick={() => setShowPicker(false)} className="text-slate-400 hover:text-slate-700 text-lg font-bold">✕</button>
            </div>

            <p className="text-xs text-slate-400 mb-5">Select a connection provider. OAuth allows secure access without entering passwords.</p>

            <div className="space-y-3 mb-6">
              <button
                onClick={() => handleOAuth("google")}
                className="w-full text-left p-4 rounded-xl border border-slate-200 hover:border-indigo-500 hover:bg-indigo-50/10 transition-all flex items-center gap-4 cursor-pointer outline-none focus:outline-none"
              >
                <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-lg shadow-sm">
                  🌐
                </div>
                <div>
                  <h4 className="font-bold text-slate-800 text-sm">Google / Gmail Account</h4>
                  <p className="text-[11px] text-slate-500 mt-0.5">Secure Google single sign-on (Workspace & Gmail)</p>
                </div>
              </button>

              <button
                onClick={() => handleOAuth("microsoft")}
                className="w-full text-left p-4 rounded-xl border border-slate-200 hover:border-indigo-500 hover:bg-indigo-50/10 transition-all flex items-center gap-4 cursor-pointer outline-none focus:outline-none"
              >
                <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-lg shadow-sm">
                  ✉️
                </div>
                <div>
                  <h4 className="font-bold text-slate-800 text-sm">Microsoft / Outlook Account</h4>
                  <p className="text-[11px] text-slate-500 mt-0.5">Secure Microsoft single sign-on (Office 365 & Outlook)</p>
                </div>
              </button>

              <button
                onClick={() => { setShowPicker(false); setShowForm(true); }}
                className="w-full text-left p-4 rounded-xl border border-slate-200 hover:border-indigo-500 hover:bg-indigo-50/10 transition-all flex items-center gap-4 cursor-pointer outline-none focus:outline-none"
              >
                <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-lg shadow-sm">
                  ⚙️
                </div>
                <div>
                  <h4 className="font-bold text-slate-800 text-sm">Custom SMTP / IMAP Credentials</h4>
                  <p className="text-[11px] text-slate-500 mt-0.5">Connect manually using hosts, ports, and app passwords</p>
                </div>
              </button>
            </div>

            <div className="flex justify-end">
              <Button size="sm" variant="secondary" onClick={() => setShowPicker(false)}>Cancel</Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showForm && (
        <Card className="p-6 mb-6">
          <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-100">
            <h3 className="font-bold text-slate-900 text-sm">Add Manual SMTP/IMAP Account</h3>
            <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-700 text-xs font-bold">✕ Close</button>
          </div>
          {error && <div className="bg-rose-50 border border-rose-200 text-rose-700 text-xs p-3.5 rounded-xl mb-4 font-semibold">✗ {error}</div>}

          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Input label="Display Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Sales Account" />
              <Input label="Sender Email" type="email" value={form.email} onChange={handleEmailChange} required placeholder="e.g. name@domain.com" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input label="SMTP Host" value={form.smtp_host} onChange={e => setForm({ ...form, smtp_host: e.target.value })} required placeholder="smtp.example.com" />
              <Input label="SMTP Port" type="number" value={form.smtp_port} onChange={e => setForm({ ...form, smtp_port: +e.target.value })} required />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input label="IMAP Host" value={form.imap_host} onChange={e => setForm({ ...form, imap_host: e.target.value })} required placeholder="imap.example.com" />
              <Input label="IMAP Port" type="number" value={form.imap_port} onChange={e => setForm({ ...form, imap_port: +e.target.value })} required />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input label="SMTP/IMAP Username" value={form.smtp_username} onChange={e => setForm({ ...form, smtp_username: e.target.value })} required placeholder="username or email" />
              <div>
                <Input
                  label="Password / App Password"
                  type="password"
                  value={form.smtp_password}
                  onChange={e => setForm({ ...form, smtp_password: e.target.value })}
                  placeholder="App Password recommended"
                  required
                />
                <button type="button" onClick={testConnection} disabled={testingConnection || loading}
                  className="text-[11px] text-indigo-600 hover:text-indigo-800 font-bold mt-1.5 flex items-center gap-1.5 cursor-pointer outline-none focus:outline-none"
                >
                  {testingConnection && <span className="w-2.5 h-2.5 border border-indigo-600/30 border-t-indigo-600 rounded-full animate-spin" />}
                  {testingConnection ? "Verifying settings..." : "⚡ Test connection credentials"}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Input label="Daily Sending Limit" type="number" min={1} max={500} value={form.daily_limit} onChange={e => setForm({ ...form, daily_limit: +e.target.value })} />
              <div className="flex items-end gap-4 pb-2 flex-wrap">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={form.use_tls} onChange={e => setForm({ ...form, use_tls: e.target.checked })} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 w-4 h-4" />
                  Use TLS (SMTP)
                </label>
                <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={form.imap_use_ssl} onChange={e => setForm({ ...form, imap_use_ssl: e.target.checked })} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 w-4 h-4" />
                  Use SSL (IMAP)
                </label>
                <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={form.is_warming_up} onChange={e => setForm({ ...form, is_warming_up: e.target.checked })} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 w-4 h-4" />
                  Warming Up
                </label>
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
              <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button type="submit" disabled={loading}>{loading ? "Saving..." : "Add Account"}</Button>
            </div>
          </form>
        </Card>
      )}

      {selectedIds.length > 0 && (
        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4 mb-6 flex items-center justify-between shadow-sm animate-fade-in">
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-indigo-900">
              Selected {selectedIds.length} of {accounts.length} account{selectedIds.length !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                const firstSelected = accounts.find(a => a.id === selectedIds[0]);
                if (firstSelected) {
                  setBulkForm({
                    daily_limit: firstSelected.daily_limit,
                    is_active: firstSelected.is_active,
                    is_warming_up: firstSelected.is_warming_up,
                    update_limit: false,
                    update_active: false,
                    update_warming: false,
                  });
                }
                setShowBulkModal(true);
              }}
            >
              ⚙️ Bulk Update Settings
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSelectedIds([])}
            >
              Clear Selection
            </Button>
          </div>
        </div>
      )}

      {accounts.length > 0 && (
        <div className="flex items-center justify-between mb-3 px-1">
          <label className="flex items-center gap-2 text-xs font-bold text-slate-500 cursor-pointer">
            <input
              type="checkbox"
              checked={accounts.length > 0 && selectedIds.length === accounts.length}
              onChange={handleSelectAll}
              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 w-4 h-4 cursor-pointer"
            />
            Select All Accounts ({accounts.length})
          </label>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {accounts.map(a => {
          const healthColors = {
            HEALTHY: "green",
            WARMING: "blue",
            THROTTLED: "yellow",
            PAUSED: "red",
          };
          const usedPct = Math.round((a.emails_sent_today / a.daily_limit) * 100);
          return (
            <Card key={a.id} className="p-5 flex gap-4 items-start">
              <input
                type="checkbox"
                checked={selectedIds.includes(a.id)}
                onChange={() => {
                  setSelectedIds(prev =>
                    prev.includes(a.id)
                      ? prev.filter(id => id !== a.id)
                      : [...prev, a.id]
                  );
                }}
                className="mt-1 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 w-4 h-4 cursor-pointer flex-shrink-0"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-800 text-sm">{a.name}</span>
                      {a.provider === "google" && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-100">OAuth: Google</span>}
                      {a.provider === "microsoft" && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-100">OAuth: Microsoft</span>}
                      {(!a.provider || a.provider === "custom") && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-50 text-slate-600 border border-slate-200">Custom SMTP</span>}
                    </div>
                    <span className="text-slate-400 text-xs font-semibold font-mono block mt-1">{a.email}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-slate-500 font-semibold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={a.is_warming_up}
                        onChange={async (e) => {
                          try {
                            await api("PATCH", `/email-accounts/${a.id}`, { is_warming_up: e.target.checked });
                            load();
                          } catch (err) {
                            alert("Failed to toggle warm-up mode: " + err.message);
                          }
                        }}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 w-3.5 h-3.5 cursor-pointer"
                      />
                      Warming Up
                    </label>
                    <Badge color={healthColors[a.health_status] || "gray"}>
                      {a.health_status || "HEALTHY"}
                    </Badge>
                    <span className="text-xs font-semibold text-slate-500">{a.emails_sent_today}/{a.daily_limit} sent today</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="text-xs border-rose-100 text-rose-600 hover:bg-rose-50"
                      onClick={async () => {
                        if (confirm(`Are you sure you want to disconnect and delete the account: ${a.email}?`)) {
                          await api("DELETE", `/email-accounts/${a.id}`);
                          load();
                        }
                      }}
                    >
                      Disconnect
                    </Button>
                  </div>
                </div>
                <div className="mt-3.5">
                  <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${usedPct >= 90 ? "bg-rose-500" :
                        usedPct >= 70 ? "bg-amber-500" : "bg-emerald-500"
                        }`}
                      style={{ width: `${Math.min(usedPct, 100)}%` }}
                    />
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {showBulkModal && createPortal(
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 border border-slate-100">
            <div className="flex items-center justify-between mb-4 pb-2 border-b border-slate-100">
              <h3 className="font-bold text-slate-900 text-base">Bulk Update Settings</h3>
              <button onClick={() => setShowBulkModal(false)} className="text-slate-400 hover:text-slate-700 text-lg font-bold">✕</button>
            </div>

            <p className="text-xs text-slate-400 mb-5">
              Select which settings to update for the {selectedIds.length} selected accounts.
            </p>

            <form onSubmit={handleBulkUpdate} className="space-y-5">
              <div className="border border-slate-100 rounded-xl p-4 bg-slate-50/50">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer mb-2">
                  <input
                    type="checkbox"
                    checked={bulkForm.update_limit}
                    onChange={e => setBulkForm({ ...bulkForm, update_limit: e.target.checked })}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 w-4 h-4 cursor-pointer"
                  />
                  Update Daily Sending Limit
                </label>
                {bulkForm.update_limit && (
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={bulkForm.daily_limit}
                    onChange={e => setBulkForm({ ...bulkForm, daily_limit: +e.target.value })}
                    className="mt-1"
                    required
                  />
                )}
              </div>

              <div className="border border-slate-100 rounded-xl p-4 bg-slate-50/50">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer mb-2">
                  <input
                    type="checkbox"
                    checked={bulkForm.update_active}
                    onChange={e => setBulkForm({ ...bulkForm, update_active: e.target.checked })}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 w-4 h-4 cursor-pointer"
                  />
                  Update Active / Disabled Status
                </label>
                {bulkForm.update_active && (
                  <div className="flex gap-4 mt-2 pl-6">
                    <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer">
                      <input
                        type="radio"
                        name="bulk_active"
                        checked={bulkForm.is_active === true}
                        onChange={() => setBulkForm({ ...bulkForm, is_active: true })}
                        className="text-indigo-600 focus:ring-indigo-500/20"
                      />
                      Active (Enable)
                    </label>
                    <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer">
                      <input
                        type="radio"
                        name="bulk_active"
                        checked={bulkForm.is_active === false}
                        onChange={() => setBulkForm({ ...bulkForm, is_active: false })}
                        className="text-indigo-600 focus:ring-indigo-500/20"
                      />
                      Disabled (Pause)
                    </label>
                  </div>
                )}
              </div>

              <div className="border border-slate-100 rounded-xl p-4 bg-slate-50/50">
                <label className="flex items-center gap-2 text-xs font-bold text-slate-700 cursor-pointer mb-2">
                  <input
                    type="checkbox"
                    checked={bulkForm.update_warming}
                    onChange={e => setBulkForm({ ...bulkForm, update_warming: e.target.checked })}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/20 w-4 h-4 cursor-pointer"
                  />
                  Update Warm-up Mode
                </label>
                {bulkForm.update_warming && (
                  <div className="flex gap-4 mt-2 pl-6">
                    <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer">
                      <input
                        type="radio"
                        name="bulk_warming"
                        checked={bulkForm.is_warming_up === true}
                        onChange={() => setBulkForm({ ...bulkForm, is_warming_up: true })}
                        className="text-indigo-600 focus:ring-indigo-500/20"
                      />
                      Enable Warm-up
                    </label>
                    <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer">
                      <input
                        type="radio"
                        name="bulk_warming"
                        checked={bulkForm.is_warming_up === false}
                        onChange={() => setBulkForm({ ...bulkForm, is_warming_up: false })}
                        className="text-indigo-600 focus:ring-indigo-500/20"
                      />
                      Disable Warm-up
                    </label>
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
                <Button type="button" variant="secondary" onClick={() => setShowBulkModal(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={loading || (!bulkForm.update_limit && !bulkForm.update_active && !bulkForm.update_warming)}>
                  {loading ? "Updating..." : "Apply Changes"}
                </Button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// ─── Master Inbox ─────────────────────────────────────────────────────────────
function Inbox() {
  const [conversations, setConversations] = useState([]);
  const [campaigns, setCampaigns] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all"); // all | unread | replied | interested | starred | opted_out
  const [selectedCampaignId, setSelectedCampaignId] = useState(null);
  const [sortBy, setSortBy] = useState("newest"); // newest | oldest

  const [replyBody, setReplyBody] = useState("");
  const [sending, setSending] = useState(false);

  // Starring system (local persistence)
  const [starredIds, setStarredIds] = useState(() => {
    try {
      const saved = localStorage.getItem("cr_starred_conversations");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    localStorage.setItem("cr_starred_conversations", JSON.stringify(starredIds));
  }, [starredIds]);

  const toggleStar = (convId, e) => {
    e.stopPropagation();
    setStarredIds(prev =>
      prev.includes(convId) ? prev.filter(id => id !== convId) : [...prev, convId]
    );
  };

  // Draft recovery (local persistence)
  const getDraft = (convId) => {
    try {
      return localStorage.getItem(`cr_draft_${convId}`) || "";
    } catch {
      return "";
    }
  };

  const saveDraft = (convId, text) => {
    try {
      if (text) {
        localStorage.setItem(`cr_draft_${convId}`, text);
      } else {
        localStorage.removeItem(`cr_draft_${convId}`);
      }
    } catch {
      // ignore
    }
  };

  const handleReplyBodyChange = (text) => {
    setReplyBody(text);
    if (selected) {
      saveDraft(selected.id, text);
    }
  };

  // Collapsible lead details (local persistence with responsive default)
  const [showDetails, setShowDetails] = useState(() => {
    try {
      const val = localStorage.getItem("cr_inbox_show_details");
      if (val !== null) return val !== "false";
      // Responsive default: collapse on medium/tablet viewports, open on wide screens
      return window.innerWidth >= 1280;
    } catch {
      return true;
    }
  });

  const toggleDetails = () => {
    setShowDetails(prev => {
      localStorage.setItem("cr_inbox_show_details", !prev);
      return !prev;
    });
  };

  // Lead custom note & status updates
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api("GET", "/inbox"),
      api("GET", "/campaigns")
    ]).then(([inboxData, campaignData]) => {
      setConversations(inboxData);
      setCampaigns(campaignData);
    }).catch(err => {
      console.error(err);
    }).finally(() => setLoading(false));
  }, []);

  const openConversation = async (conv) => {
    if (selected) {
      saveDraft(selected.id, replyBody);
    }
    const draft = getDraft(conv.id);
    setReplyBody(draft);
    setNoteText("");

    try {
      const full = await api("GET", `/inbox/${conv.id}`);
      setSelected(full);
      setNoteText(full.lead?.status_note || "");
      setConversations(cs => cs.map(c => c.id === conv.id ? { ...c, has_unread: false } : c));
    } catch (e) {
      alert("Failed to load conversation: " + e.message);
    }
  };

  const handleSendReply = async () => {
    if (!replyBody.trim()) return;
    setSending(true);
    try {
      await api("POST", `/inbox/${selected.id}/reply`, { body: replyBody });
      setReplyBody("");
      saveDraft(selected.id, ""); // clear draft
      const full = await api("GET", `/inbox/${selected.id}`);
      setSelected(full);
      const feed = await api("GET", "/inbox");
      setConversations(feed);
    } catch (e) {
      alert("Failed to send reply: " + e.message);
    } finally {
      setSending(false);
    }
  };

  const handleUpdateStatus = async (newStatus) => {
    if (!selected) return;
    try {
      const res = await api("PATCH", `/campaigns/${selected.campaign_id}/leads/${selected.lead.id}/status`, {
        status: newStatus,
        note: noteText || `Status updated via Inbox to ${newStatus}`
      });

      setSelected(curr => ({
        ...curr,
        lead: {
          ...curr.lead,
          status: res.status,
          status_note: res.status_note
        }
      }));

      setConversations(cs => cs.map(c =>
        c.lead?.id === selected.lead.id
          ? { ...c, lead: { ...c.lead, status: res.status } }
          : c
      ));
    } catch (e) {
      alert("Failed to update status: " + e.message);
    }
  };

  const handleSaveNote = async () => {
    if (!selected) return;
    setSavingNote(true);
    try {
      const res = await api("PATCH", `/campaigns/${selected.campaign_id}/leads/${selected.lead.id}/status`, {
        status: selected.lead.status,
        note: noteText
      });
      setSelected(curr => ({
        ...curr,
        lead: {
          ...curr.lead,
          status_note: res.status_note
        }
      }));
      alert("Note saved successfully!");
    } catch (e) {
      alert("Failed to save note: " + e.message);
    } finally {
      setSavingNote(false);
    }
  };

  const insertVariable = (variable) => {
    const textarea = document.getElementById("inbox-composer-textarea");
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const before = text.substring(0, start);
    const after = text.substring(end, text.length);
    const newText = before + `{${variable}}` + after;
    handleReplyBodyChange(newText);
    setTimeout(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + variable.length + 2;
    }, 0);
  };

  const getInitials = (lead) => {
    if (!lead) return "?";
    return `${(lead.first_name || "")[0] || ""}${(lead.last_name || "")[0] || ""}`.toUpperCase() || lead.email[0].toUpperCase();
  };

  const getAvatarColor = (id) => {
    const colors = [
      "linear-gradient(135deg, #6366f1, #4f46e5)", // Indigo
      "linear-gradient(135deg, #ec4899, #db2777)", // Pink
      "linear-gradient(135deg, #0ea5e9, #0284c7)", // Sky
      "linear-gradient(135deg, #10b981, #059669)", // Emerald
      "linear-gradient(135deg, #f59e0b, #d97706)", // Amber
      "linear-gradient(135deg, #8b5cf6, #7c3aed)", // Violet
      "linear-gradient(135deg, #f43f5e, #e11d48)", // Rose
      "linear-gradient(135deg, #06b6d4, #0891b2)", // Cyan
    ];
    return colors[id % colors.length];
  };

  const formatTime = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return "just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return d.toLocaleDateString([], { weekday: "short" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  };

  // Helper for message snippet preview
  const getSnippet = (c) => {
    const lastMsg = c.messages && c.messages.length > 0
      ? c.messages[c.messages.length - 1]
      : null;
    if (!lastMsg) return c.lead?.company || c.lead?.email || "";
    const prefix = lastMsg.direction === "OUTBOUND" ? "You: " : "";
    return `${prefix}${lastMsg.body}`;
  };

  // Folder and Campaign Filtering logic
  const filtered = conversations.filter(c => {
    const name = `${c.lead?.first_name || ""} ${c.lead?.last_name || ""} ${c.lead?.email || ""} ${c.lead?.company || ""}`.toLowerCase();
    const matchSearch = name.includes(search.toLowerCase());

    const matchCampaign = selectedCampaignId === null || c.campaign_id === selectedCampaignId;

    let matchFilter = true;
    if (filter === "unread") {
      matchFilter = c.has_unread;
    } else if (filter === "replied") {
      matchFilter = ["REPLIED", "INTERESTED", "MEETING_BOOKED", "OUT_OF_OFFICE"].includes(c.lead?.status);
    } else if (filter === "interested") {
      matchFilter = ["INTERESTED", "MEETING_BOOKED"].includes(c.lead?.status);
    } else if (filter === "starred") {
      matchFilter = starredIds.includes(c.id);
    } else if (filter === "opted_out") {
      matchFilter = ["UNSUBSCRIBED", "DO_NOT_CONTACT", "NOT_INTERESTED", "WRONG_PERSON", "BOUNCED"].includes(c.lead?.status);
    }

    return matchSearch && matchCampaign && matchFilter;
  });

  const sortedConversations = [...filtered].sort((a, b) => {
    const timeA = new Date(a.last_message_at || 0).getTime();
    const timeB = new Date(b.last_message_at || 0).getTime();
    return sortBy === "newest" ? timeB - timeA : timeA - timeB;
  });

  // Folder Counts
  const allCount = conversations.length;
  const unreadCount = conversations.filter(c => c.has_unread).length;
  const repliedCount = conversations.filter(c => ["REPLIED", "INTERESTED", "MEETING_BOOKED", "OUT_OF_OFFICE"].includes(c.lead?.status)).length;
  const interestedCount = conversations.filter(c => ["INTERESTED", "MEETING_BOOKED"].includes(c.lead?.status)).length;
  const starredCount = conversations.filter(c => starredIds.includes(c.id)).length;
  const optedOutCount = conversations.filter(c => ["UNSUBSCRIBED", "DO_NOT_CONTACT", "NOT_INTERESTED", "WRONG_PERSON", "BOUNCED"].includes(c.lead?.status)).length;

  const campaignName = selected
    ? campaigns.find(camp => camp.id === selected.campaign_id)?.name || "Unknown Campaign"
    : "";

  const messagesByDate = selected && selected.messages
    ? (() => {
        const groups = {};
        selected.messages.forEach(msg => {
          const dateStr = new Date(msg.timestamp).toLocaleDateString([], {
            weekday: "long",
            month: "short",
            day: "numeric",
            year: "numeric"
          });
          if (!groups[dateStr]) {
            groups[dateStr] = [];
          }
          groups[dateStr].push(msg);
        });
        return groups;
      })()
    : {};

  if (loading) return (
    <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
      <div className="w-9 h-9 border-3 border-slate-200 border-t-indigo-600 rounded-full animate-spin" />
      <p className="text-slate-400 text-xs font-semibold">Loading inbox…</p>
    </div>
  );

  return (
    <div className="flex h-[calc(100vh-140px)] bg-white rounded-2xl overflow-hidden border border-slate-200/80 shadow-2xl shadow-slate-200/50 font-sans animate-fade-in">
      {/* Pane 1: Unified Thread List & Filters */}
      <div className="w-80 lg:w-96 flex-shrink-0 flex flex-col border-r border-slate-200 bg-slate-50/40">
        
        {/* Header: Title & Campaign Filter Selector */}
        <div className="p-4 border-b border-slate-200 bg-white flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-extrabold text-slate-800 tracking-wider">
              📥 INBOX
            </span>
            {unreadCount > 0 && (
              <span className="bg-indigo-600 text-white text-[9px] font-black px-1.5 py-0.5 rounded-full shadow-sm animate-pulse">
                {unreadCount}
              </span>
            )}
          </div>
          <select
            value={selectedCampaignId || ""}
            onChange={e => setSelectedCampaignId(e.target.value ? Number(e.target.value) : null)}
            className="bg-slate-50 border border-slate-200 rounded-lg text-[10px] font-bold text-slate-700 py-1.5 px-2 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer max-w-[150px] truncate outline-none"
          >
            <option value="">💼 All Campaigns</option>
            {campaigns.map(camp => (
              <option key={camp.id} value={camp.id}>
                📁 {camp.name}
              </option>
            ))}
          </select>
        </div>

        {/* Folder Pills Bar */}
        <div
          className="flex gap-1.5 overflow-x-auto py-2.5 px-4 border-b border-slate-200/60 bg-slate-50/30 select-none"
          style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
        >
          {[
            { id: "all", label: "All", count: allCount, icon: "📩" },
            { id: "unread", label: "Unread", count: unreadCount, icon: "📥" },
            { id: "replied", label: "Replied", count: repliedCount, icon: "💬" },
            { id: "interested", label: "Interested", count: interestedCount, icon: "⭐" },
            { id: "starred", label: "Starred", count: starredCount, icon: "📍" },
            { id: "opted_out", label: "Opt Out", count: optedOutCount, icon: "🛑" }
          ].map(fld => (
            <button
              key={fld.id}
              type="button"
              onClick={() => setFilter(fld.id)}
              className={`px-3 py-1 rounded-full text-[11px] font-bold tracking-wide transition-all flex items-center gap-1.5 flex-shrink-0 cursor-pointer ${
                filter === fld.id
                  ? "bg-slate-900 text-white shadow-sm"
                  : "bg-white border border-slate-200 text-slate-500 hover:text-slate-800"
              }`}
            >
              <span>{fld.icon}</span>
              <span>{fld.label}</span>
              {fld.count > 0 && (
                <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded-full ${
                  filter === fld.id ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-500"
                }`}>
                  {fld.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Search & Sort Panel */}
        <div className="p-3 border-b border-slate-200 bg-white">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none">
                <svg className="h-3.5 w-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
                </svg>
              </span>
              <input
                type="text"
                className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-all font-medium outline-none"
                placeholder="Search conversations…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <button
              type="button"
              onClick={() => setSortBy(sortBy === "newest" ? "oldest" : "newest")}
              className="px-2.5 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-xs font-bold text-slate-600 transition-colors flex items-center gap-1 cursor-pointer flex-shrink-0 outline-none"
              title={sortBy === "newest" ? "Sorting newest first" : "Sorting oldest first"}
            >
              <span>{sortBy === "newest" ? "⚡ Newest" : "⏰ Oldest"}</span>
            </button>
          </div>
        </div>

        {/* Scrollable list */}
        <div className="flex-1 overflow-y-auto divide-y divide-slate-100 bg-white">
          {sortedConversations.length === 0 && (
            <div className="p-10 text-center">
              <div className="text-2xl mb-2">📭</div>
              <p className="text-slate-400 text-xs font-semibold">No conversations found</p>
            </div>
          )}
          {sortedConversations.map(c => {
            const isSelected = selected?.id === c.id;
            const isStarred = starredIds.includes(c.id);
            return (
              <div
                key={c.id}
                onClick={() => openConversation(c)}
                className={`p-3.5 flex gap-3 items-start cursor-pointer transition-all border-l-3 relative group ${
                  isSelected
                    ? "bg-indigo-50/30 border-l-indigo-600 shadow-sm z-10"
                    : "border-l-transparent hover:bg-slate-50/50"
                }`}
              >
                {/* Avatar with unread indicator */}
                <div className="relative flex-shrink-0">
                  <div
                    style={{ background: getAvatarColor(c.id) }}
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-extrabold text-xs shadow-sm"
                  >
                    {getInitials(c.lead)}
                  </div>
                  {c.has_unread && (
                    <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-indigo-600 rounded-full ring-2 ring-white shadow-sm shadow-indigo-600/30 animate-pulse" />
                  )}
                </div>

                {/* Card text */}
                <div className="flex-1 min-w-0">
                  <div className="flex justify-between items-baseline mb-1">
                    <span className={`text-xs truncate max-w-[130px] block ${
                      c.has_unread ? "font-extrabold text-slate-900" : "font-bold text-slate-700"
                    }`}>
                      {c.lead?.first_name} {c.lead?.last_name}
                    </span>
                    <span className="text-[9px] text-slate-400 font-semibold">{formatTime(c.last_message_at)}</span>
                  </div>

                  <p className="text-[10px] text-slate-400 font-semibold truncate mb-1">
                    {c.lead?.company || c.lead?.email}
                  </p>

                  <p className={`text-[11px] truncate mb-2 leading-tight ${
                    c.has_unread ? "text-slate-800 font-bold" : "text-slate-400 font-medium"
                  }`}>
                    {getSnippet(c)}
                  </p>

                  <div className="flex items-center justify-between">
                    <StatusBadge status={c.lead?.status || "NEW"} />
                    <button
                      type="button"
                      onClick={(e) => toggleStar(c.id, e)}
                      className={`text-xs transition-opacity duration-150 outline-none focus:outline-none ${
                        isStarred
                          ? "opacity-100 text-amber-400 hover:text-amber-500 scale-110"
                          : "opacity-0 group-hover:opacity-60 text-slate-300 hover:text-amber-400"
                      }`}
                      title={isStarred ? "Unstar conversation" : "Star conversation"}
                    >
                      ★
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Pane 2: Conversation Chat Thread & Composer */}
      <div className="flex-1 flex flex-col bg-white overflow-hidden">
        {selected ? (
          <>
            {/* Header info */}
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between flex-shrink-0 bg-white/70 backdrop-blur-md z-10">
              <div className="flex items-center gap-3 min-w-0">
                <div
                  style={{ background: getAvatarColor(selected.id) }}
                  className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-extrabold text-xs shadow-sm flex-shrink-0"
                >
                  {getInitials(selected.lead)}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <h2 className="text-sm font-extrabold text-slate-900 m-0 truncate max-w-[150px] sm:max-w-none">
                      {selected.lead?.first_name} {selected.lead?.last_name}
                    </h2>
                    <StatusBadge status={selected.lead?.status || "NEW"} />
                    {starredIds.includes(selected.id) && (
                      <span className="text-amber-400 text-xs font-bold" title="Starred">★</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap text-[10px] text-slate-400 font-bold">
                    <a href={`mailto:${selected.lead?.email}`} className="hover:text-indigo-600 transition-colors truncate max-w-[140px] sm:max-w-none">
                      {selected.lead?.email}
                    </a>
                    {selected.lead?.company && (
                      <>
                        <span>·</span>
                        <span className="text-slate-500 truncate max-w-[100px] sm:max-w-none">{selected.lead?.company}</span>
                      </>
                    )}
                    <span>·</span>
                    <span className="text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded font-extrabold text-[9px] truncate max-w-[100px] sm:max-w-[150px]" title={campaignName}>
                      {campaignName}
                    </span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  type="button"
                  onClick={(e) => toggleStar(selected.id, e)}
                  className={`p-1.5 border border-slate-200 rounded-lg text-xs transition-colors hover:bg-slate-50 cursor-pointer outline-none ${
                    starredIds.includes(selected.id) ? "text-amber-400 border-amber-200 bg-amber-50/20" : "text-slate-400"
                  }`}
                  title="Star/Highlight Conversation"
                >
                  ★
                </button>
                <button
                  type="button"
                  onClick={toggleDetails}
                  className={`px-2.5 py-1.5 border rounded-lg text-xs font-bold transition-all flex items-center gap-1 cursor-pointer outline-none ${
                    showDetails
                      ? "bg-slate-900 text-white border-slate-900 hover:bg-slate-800"
                      : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
                  }`}
                >
                  ℹ Details {showDetails ? "→" : "←"}
                </button>
              </div>
            </div>

            {/* Chat list */}
            <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5 bg-slate-50/20">
              {Object.keys(messagesByDate).length === 0 ? (
                <div className="text-center py-12 text-slate-400 text-xs font-semibold">No messages in this conversation.</div>
              ) : (
                Object.entries(messagesByDate).map(([dateStr, msgs]) => (
                  <div key={dateStr} className="space-y-4">
                    {/* Date line separator */}
                    <div className="flex items-center justify-center my-4">
                      <div className="h-[1px] bg-slate-200 flex-1" />
                      <span className="px-3 text-[10px] text-slate-400 font-extrabold tracking-wider uppercase bg-white border border-slate-100 rounded-full py-0.5">
                        {dateStr}
                      </span>
                      <div className="h-[1px] bg-slate-200 flex-1" />
                    </div>

                    {/* Messages bubbles */}
                    {msgs.map((msg) => {
                      const isOut = msg.direction === "OUTBOUND";
                      return (
                        <div key={msg.id} className="flex flex-col gap-1" style={{ alignItems: isOut ? "flex-end" : "flex-start" }}>
                          <div className="flex items-center gap-1.5 mb-0.5">
                            {!isOut && (
                              <div
                                style={{ background: getAvatarColor(selected.id) }}
                                className="w-4 h-4 rounded-md flex items-center justify-center text-white font-extrabold text-[8px]"
                              >
                                {getInitials(selected.lead)}
                              </div>
                            )}
                            <span className="text-[9px] text-slate-400 font-semibold">
                              {isOut ? "You" : selected.lead?.first_name} · {new Date(msg.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                            </span>
                            {isOut && (
                              <div className="w-4 h-4 rounded bg-slate-900 flex items-center justify-center shadow-sm">
                                <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="3">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5" />
                                </svg>
                              </div>
                            )}
                          </div>

                          <div
                            className={`max-w-[75%] p-3.5 text-xs leading-relaxed shadow-sm transition-all hover:shadow-md ${
                              isOut
                                ? "bg-slate-900 text-white rounded-2xl rounded-tr-none"
                                : "bg-white text-slate-800 border border-slate-200 rounded-2xl rounded-tl-none"
                            }`}
                          >
                            {msg.subject && (
                              <p className={`margin-0 mb-1.5 text-[9px] font-extrabold tracking-wider uppercase ${isOut ? "text-indigo-300" : "text-indigo-600"}`}>
                                Subj: {msg.subject}
                              </p>
                            )}
                            <p className="margin-0 whitespace-pre-wrap break-words font-medium">{msg.body}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            {/* composer reply block */}
            <div className="p-4 border-t border-slate-200 bg-slate-50/50 flex-shrink-0 flex flex-col gap-2">
              <div className="border border-slate-200 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-100 rounded-xl bg-white transition-all shadow-sm">
                
                {/* Advanced Composer Toolbar */}
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-slate-100 bg-slate-50/50 rounded-t-xl text-[10px] text-slate-500 font-bold select-none">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400">Insert Variable:</span>
                    {["first_name", "company", "website"].map(field => (
                      <button
                        key={field}
                        type="button"
                        onClick={() => insertVariable(field)}
                        className="px-2 py-0.5 bg-white border border-slate-200 rounded text-slate-700 hover:bg-indigo-50 hover:text-indigo-600 transition-colors cursor-pointer outline-none"
                      >
                        {`{${field}}`}
                      </button>
                    ))}
                  </div>
                  {replyBody.trim() && (
                    <span className="text-indigo-600 font-extrabold animate-pulse text-[9px]">Draft auto-saved</span>
                  )}
                </div>

                {/* Textarea */}
                <textarea
                  id="inbox-composer-textarea"
                  rows={4}
                  value={replyBody}
                  onChange={e => handleReplyBodyChange(e.target.value)}
                  placeholder={`Reply to ${selected.lead?.first_name || selected.lead?.email}...`}
                  className="w-full border-0 focus:ring-0 text-xs px-4 py-3 placeholder-slate-400 resize-none outline-none text-slate-800 font-medium"
                  onKeyDown={e => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSendReply();
                    }
                  }}
                />

                {/* Action footer inside composer */}
                <div className="flex items-center justify-between px-3 py-2 bg-slate-50 border-t border-slate-100 rounded-b-xl">
                  <span className="text-[9px] text-slate-400 font-bold flex items-center gap-1">
                    <svg className="w-3.5 h-3.5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5" /></svg>
                    Sends via assigned SMTP/OAuth inbox
                  </span>
                  <Button
                    size="sm"
                    onClick={handleSendReply}
                    disabled={sending || !replyBody.trim()}
                    className="text-xs font-bold"
                  >
                    {sending ? (
                      <>
                        <div className="w-3 h-3 border-2 border-slate-200 border-t-white rounded-full animate-spin" />
                        Sending...
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5 transform rotate-45 -mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
                        Send Reply
                      </>
                    )}
                  </Button>
                </div>
              </div>
              <p className="margin-0 text-[9px] text-slate-400 text-center font-semibold">
                Replies are sent via SMTP client. Inbound messages are automatically detected & threaded.
              </p>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center p-8 bg-slate-50/10">
            <div className="w-14 h-14 rounded-2xl bg-indigo-50 border border-indigo-100 text-indigo-500 flex items-center justify-center shadow-sm">
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0a2 2 0 01-2 2H6a2 2 0 01-2-2m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
            </div>
            <div>
              <h3 className="font-extrabold text-sm text-slate-900 m-0">Select a conversation</h3>
              <p className="text-xs text-slate-400 mt-1 max-w-xs">{conversations.length} total · {unreadCount} unread</p>
            </div>
          </div>
        )}
      </div>

      {/* Pane 3: Collapsible Right Lead Sidebar */}
      {selected && showDetails && (
        <div className="w-72 border-l border-slate-200 bg-white flex flex-col flex-shrink-0 overflow-y-auto">
          {/* Header Panel */}
          <div className="p-4 border-b border-slate-200 text-center flex flex-col items-center">
            <div
              style={{ background: getAvatarColor(selected.id) }}
              className="w-16 h-16 rounded-2xl flex items-center justify-center text-white font-extrabold text-lg shadow-md mb-2"
            >
              {getInitials(selected.lead)}
            </div>
            <h3 className="font-extrabold text-sm text-slate-900 m-0">
              {selected.lead?.first_name} {selected.lead?.last_name}
            </h3>
            <p className="text-[10px] text-slate-400 font-bold mt-0.5 truncate max-w-full">
              {selected.lead?.company || selected.lead?.email}
            </p>
          </div>

          <div className="p-4 space-y-4 divide-y divide-slate-100">
            {/* Status updates section */}
            <div className="pt-0 space-y-2">
              <label className="text-[10px] font-extrabold tracking-wider text-slate-400 uppercase block mb-1">Lead Status</label>
              <div className="relative">
                <select
                  value={selected.lead?.status || "NEW"}
                  onChange={(e) => handleUpdateStatus(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg text-xs font-bold text-slate-700 py-2 px-3 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 cursor-pointer outline-none"
                >
                  <option value="NEW">🆕 New Lead</option>
                  <option value="CONTACTED">✉️ Contacted</option>
                  <option value="REPLIED">💬 Replied</option>
                  <option value="OUT_OF_OFFICE">🌴 Out of Office</option>
                  <option value="INTERESTED">🔥 Interested</option>
                  <option value="MEETING_BOOKED">📅 Meeting Booked</option>
                  <option value="NOT_INTERESTED">❄️ Not Interested</option>
                  <option value="WRONG_PERSON">❓ Wrong Person</option>
                  <option value="DO_NOT_CONTACT">🚫 DND (Do Not Contact)</option>
                  <option value="UNSUBSCRIBED">🔕 Unsubscribed</option>
                  <option value="BOUNCED">💥 Bounced</option>
                </select>
              </div>
            </div>

            {/* Campaign info section */}
            <div className="pt-3.5 space-y-2 text-xs font-semibold text-slate-700">
              <label className="text-[10px] font-extrabold tracking-wider text-slate-400 uppercase block">Outreach Stats</label>
              <div className="space-y-1 bg-slate-50 rounded-xl p-3 border border-slate-100 font-semibold text-[11px] text-slate-600">
                <div className="flex justify-between">
                  <span>Campaign:</span>
                  <span className="text-slate-800 font-extrabold truncate max-w-[130px]">{campaignName}</span>
                </div>
                <div className="flex justify-between">
                  <span>Sequence Step:</span>
                  <span className="text-slate-800 font-extrabold">Step {selected.lead?.current_step || 0}</span>
                </div>
                <div className="flex justify-between">
                  <span>Created:</span>
                  <span className="text-slate-800 font-extrabold">
                    {selected.lead?.created_at ? new Date(selected.lead.created_at).toLocaleDateString([], { month: "short", day: "numeric" }) : "N/A"}
                  </span>
                </div>
              </div>
            </div>

            {/* Contact info list */}
            <div className="pt-3.5 space-y-2">
              <label className="text-[10px] font-extrabold tracking-wider text-slate-400 uppercase block">Contact Information</label>
              <div className="space-y-2 text-xs font-semibold text-slate-700">
                <div>
                  <span className="text-[10px] text-slate-400 block font-bold">Email Address</span>
                  <div className="flex items-center justify-between gap-1 mt-0.5">
                    <a href={`mailto:${selected.lead?.email}`} className="text-indigo-600 hover:underline truncate block">
                      {selected.lead?.email}
                    </a>
                    <button
                      type="button"
                      onClick={() => { navigator.clipboard.writeText(selected.lead?.email || ""); alert("Email copied!"); }}
                      className="text-[10px] hover:text-indigo-600 cursor-pointer p-1"
                      title="Copy email"
                    >
                      📋
                    </button>
                  </div>
                </div>

                {selected.lead?.website && (
                  <div>
                    <span className="text-[10px] text-slate-400 block font-bold">Website / URL</span>
                    <a
                      href={selected.lead.website.startsWith("http") ? selected.lead.website : `https://${selected.lead.website}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-600 hover:underline truncate block mt-0.5"
                    >
                      {selected.lead.website}
                    </a>
                  </div>
                )}
              </div>
            </div>

            {/* Custom fields section */}
            {selected.lead?.custom_fields && Object.keys(selected.lead.custom_fields).length > 0 && (
              <div className="pt-3.5 space-y-2">
                <label className="text-[10px] font-extrabold tracking-wider text-slate-400 uppercase block">Custom Variables</label>
                <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
                  {Object.entries(selected.lead.custom_fields).map(([key, value]) => (
                    <div key={key} className="flex justify-between gap-2 border-b border-slate-100 pb-1 text-[11px]">
                      <span className="text-slate-400 truncate max-w-[100px] font-bold" title={key}>{key}</span>
                      <span className="text-slate-700 truncate font-semibold" title={String(value)}>{String(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Notes Section */}
            <div className="pt-3.5 space-y-2">
              <label className="text-[10px] font-extrabold tracking-wider text-slate-400 uppercase block">Conversation Notes</label>
              <textarea
                rows={3}
                value={noteText}
                onChange={e => setNoteText(e.target.value)}
                placeholder="Save custom notes about this lead..."
                className="w-full bg-slate-50 border border-slate-200 rounded-lg text-[11px] p-2 placeholder-slate-400 outline-none text-slate-700 font-medium focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 resize-none"
              />
              <button
                type="button"
                onClick={handleSaveNote}
                disabled={savingNote}
                className="w-full py-1.5 bg-slate-900 text-white rounded-lg text-[11px] font-bold tracking-wide transition-colors hover:bg-slate-800 disabled:bg-slate-400 cursor-pointer outline-none"
              >
                {savingNote ? "Saving note..." : "Save Note"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────
export default function App() {
  const { user, loading, login, logout } = useAuth();
  const [page, setPage] = useState("campaigns");
  const [selectedCampaign, setSelectedCampaign] = useState(null);
  const [showNewCampaign, setShowNewCampaign] = useState(false);

  if (loading) return <div className="min-h-screen flex items-center justify-center text-slate-500 bg-slate-50">Loading...</div>;
  if (!user) return <LoginPage onLogin={login} />;

  const nav = [
    {
      id: "campaigns",
      label: "Campaigns",
      icon: (
        <svg className="w-4 h-4 mr-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
        </svg>
      )
    },
    {
      id: "inbox",
      label: "Inbox",
      icon: (
        <svg className="w-4 h-4 mr-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0a2 2 0 01-2 2H6a2 2 0 01-2-2m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
        </svg>
      )
    },
    {
      id: "accounts",
      label: "Email Accounts",
      icon: (
        <svg className="w-4 h-4 mr-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
        </svg>
      )
    },
  ];

  return (
    <div className="min-h-screen bg-[radial-gradient(ellipse_80%_80%_at_50%_-20%,rgba(99,102,241,0.05),rgba(255,255,255,0))]">
      {/* Sidebar */}
      <div className="fixed left-0 top-0 bottom-0 w-60 bg-white border-r border-slate-100 flex flex-col z-20">
        <div className="p-5 border-b border-slate-100 flex items-center gap-3">
          <div className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-indigo-600 text-white font-bold text-sm shadow-md shadow-indigo-100">
            CR
          </div>
          <div>
            <h1 className="font-bold text-sm text-slate-900 tracking-tight leading-none">ColdReach</h1>
            <span className="text-[10px] text-slate-400 font-semibold truncate max-w-[130px] block mt-1">{user.email}</span>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          {nav.map(n => (
            <button
              key={n.id}
              onClick={() => { setPage(n.id); setSelectedCampaign(null); setShowNewCampaign(false); }}
              className={`w-full text-left px-3 py-2.5 rounded-r-lg rounded-l-none text-xs tracking-wide flex items-center transition-all border-l-2 ${page === n.id
                ? "bg-indigo-50/40 text-indigo-600 border-indigo-600 font-extrabold"
                : "text-slate-500 border-transparent hover:bg-slate-50/50 hover:text-slate-900 font-semibold"
                }`}
            >
              {n.icon}
              {n.label}
            </button>
          ))}
        </nav>
        <div className="p-4 border-t border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-indigo-50 border border-indigo-200 text-indigo-700 flex items-center justify-center text-[10px] font-bold">
              {user.email.slice(0, 1).toUpperCase()}
            </div>
            <span className="text-xs text-slate-500 font-semibold max-w-[100px] truncate">{user.email.split("@")[0]}</span>
          </div>
          <button onClick={logout} className="text-xs text-rose-500 hover:text-rose-700 font-bold transition-colors">
            Sign out
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="ml-60 p-8 min-h-screen">
        <div className={`${page === "inbox" ? "max-w-none w-full" : "max-w-6xl"} mx-auto animate-fade-in`}>
          {page === "campaigns" && !selectedCampaign && !showNewCampaign && (
            <CampaignList onSelect={setSelectedCampaign} onNew={() => setShowNewCampaign(true)} />
          )}
          {page === "campaigns" && showNewCampaign && (
            <NewCampaignForm onCreated={(c) => { setShowNewCampaign(false); setSelectedCampaign(c); }} onCancel={() => setShowNewCampaign(false)} />
          )}
          {page === "campaigns" && selectedCampaign && (
            <CampaignDetail campaign={selectedCampaign} onBack={() => setSelectedCampaign(null)} />
          )}
          {page === "inbox" && <Inbox />}
          {page === "accounts" && <EmailAccounts />}
        </div>
      </div>
    </div>
  );
}