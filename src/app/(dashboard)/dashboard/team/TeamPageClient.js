"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Card, Button, Input, Modal, CardSkeleton, Toggle, ConfirmModal, Badge, SegmentedControl } from "@/shared/components";
import { getStatusVariant } from "@/shared/utils/connectionStatus";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import StatusAlert from "../endpoint/components/StatusAlert";
import TeamAnalytics from "./TeamAnalytics";

// Dashboard-only budget warnings (design: warn at 80%, critical at 90%).
const USAGE_WARN_PCT = 80;
const USAGE_CRITICAL_PCT = 90;
const BUDGET_STATUS_CLEAR_MS = 3000;

const TEAM_BUDGET_FIELDS = [
  { field: "inputTokensMonthly", usage: "inputTokens", label: "Monthly input tokens", short: "Input tokens", step: "1" },
  { field: "outputTokensMonthly", usage: "outputTokens", label: "Monthly output tokens", short: "Output tokens", step: "1" },
  { field: "creditsMonthly", usage: "credits", label: "Monthly Kiro credits", short: "Credits", step: "0.01" },
];

// Activity period selector (same value set as the Usage page).
const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

/** "" → unlimited (null); otherwise a finite non-negative number, else an error string. */
function parseBudgetInput(value, label) {
  if (value === "" || value == null) return { value: null };
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return { error: `${label} must be a non-negative number` };
  return { value: number };
}

/** Utilization of a finite monthly limit; null when the dimension is unlimited. */
function usageLevel(used, limit) {
  if (limit == null) return null;
  const pct = limit > 0 ? (used / limit) * 100 : 100;
  const level = pct >= 100 ? "exhausted"
    : pct >= USAGE_CRITICAL_PCT ? "critical"
    : pct >= USAGE_WARN_PCT ? "warning"
    : null;
  return { pct: Math.min(100, Math.round(pct)), level };
}

/** Locale-formatted number: thousands separators, up to 4 fraction digits (tokens, credits, counts). */
const fmtNum = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });
const fmtCost = (n) => `$${fmtNum(n)}`;

function usageHint(used, limit) {
  if (limit == null) return `Used ${fmtNum(used)} · Unlimited`;
  const { pct } = usageLevel(used, limit);
  return `Used ${fmtNum(used)} / ${fmtNum(limit)} · Remaining ${fmtNum(Math.max(0, limit - used))} (${pct}%)`;
}

/** " · Remaining N" suffix for a finite monthly dimension; "" when unlimited. */
function remainingHint(used, limit) {
  if (limit == null) return "";
  return ` · Remaining ${fmtNum(Math.max(0, limit - used))}`;
}

function UsageBadge({ used, limit }) {
  const level = usageLevel(used, limit);
  if (!level?.level) return null;
  if (level.level === "exhausted") return <Badge size="sm" variant="error" icon="block">Exhausted</Badge>;
  return (
    <Badge size="sm" variant={level.level === "critical" ? "error" : "warning"} icon="warning">
      {level.pct}% used
    </Badge>
  );
}

UsageBadge.propTypes = {
  used: PropTypes.number,
  limit: PropTypes.number,
};

export default function TeamPageClient() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newInputTokensMonthly, setNewInputTokensMonthly] = useState("");
  const [newOutputTokensMonthly, setNewOutputTokensMonthly] = useState("");
  const [newCreditsMonthly, setNewCreditsMonthly] = useState("");
  const [createdKey, setCreatedKey] = useState(null);
  const [createdKeyMode, setCreatedKeyMode] = useState("created");
  const [teamBudget, setTeamBudget] = useState(null);
  const [kiroAccounts, setKiroAccounts] = useState([]);
  const [teamInputTokensMonthly, setTeamInputTokensMonthly] = useState("");
  const [teamOutputTokensMonthly, setTeamOutputTokensMonthly] = useState("");
  const [teamCreditsMonthly, setTeamCreditsMonthly] = useState("");
  const [accountCreditsMonthly, setAccountCreditsMonthly] = useState({});
  const [confirmState, setConfirmState] = useState(null);
  // Inline result of the last budget action, scoped to "team" or a Kiro connectionId.
  const [budgetStatus, setBudgetStatus] = useState(null);
  const budgetStatusTimer = useRef(null);
  const autoProvisionRef = useRef(false);

  // All-provider activity per key, keyed by key name (usage stats expose a masked key, not the raw one).
  const [activityPeriod, setActivityPeriod] = useState("30d");
  const [activityByKey, setActivityByKey] = useState({});

  // API key visibility toggle state
  const [visibleKeys, setVisibleKeys] = useState(new Set());

  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams.get("tab") === "analytics" ? "analytics" : "management";

  const handleTabChange = (value) => {
    if (value === tab) return;
    router.push(`/dashboard/team?tab=${value}`, { scroll: false });
  };
  const { copied, copy } = useCopyToClipboard();

  const fetchKeys = () =>
    fetch("/api/keys")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => data?.keys || []);

  // All-provider activity from the usage stats endpoint. Rows are keyed per
  // model|provider and expose a masked key, so aggregate them per key name.
  const fetchActivity = useCallback(() => {
    return fetch(`/api/usage/stats?period=${activityPeriod}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data) return;
        const byName = {};
        for (const row of Object.values(data.byApiKey || {})) {
          const name = row.keyName || "";
          const current = byName[name] || { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
          current.requests += row.requests || 0;
          current.promptTokens += row.promptTokens || 0;
          current.completionTokens += row.completionTokens || 0;
          current.cost += row.cost || 0;
          byName[name] = current;
        }
        setActivityByKey(byName);
      })
      .catch((error) => console.log("Error fetching activity:", error));
  }, [activityPeriod]);

  const fetchData = useCallback(() => {
    let existing = [];
    // Auto-provision a default key for first-time users so the endpoint works out of the box.
    // Concurrent fetchData calls (dev StrictMode double effects) must not each create one.
    return fetchKeys()
      .then((keys) => {
        existing = keys;
        if (existing.length > 0 || autoProvisionRef.current) return existing;
        autoProvisionRef.current = true;
        return fetch("/api/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Default Key" }),
        }).then((createRes) => (createRes.ok ? fetchKeys() : existing));
      })
      .then((keys) => setKeys(keys))
      .then(() => Promise.all([
        fetch("/api/team/budget"),
        fetch("/api/kiro/accounts/budget"),
      ]))
      .then(([teamRes, accountsRes]) => Promise.all([
        teamRes.ok ? teamRes.json() : null,
        accountsRes.ok ? accountsRes.json() : null,
      ]))
      .then(([teamData, accountsData]) => {
        if (teamData) {
          const policy = teamData.policy || {};
          setTeamBudget(teamData);
          setTeamInputTokensMonthly(policy.inputTokensMonthly == null ? "" : String(policy.inputTokensMonthly));
          setTeamOutputTokensMonthly(policy.outputTokensMonthly == null ? "" : String(policy.outputTokensMonthly));
          setTeamCreditsMonthly(policy.creditsMonthly == null ? "" : String(policy.creditsMonthly));
        }
        if (accountsData) {
          const accounts = accountsData.accounts || [];
          setKiroAccounts(accounts);
          setAccountCreditsMonthly(Object.fromEntries(
            accounts.map((account) => [
              account.connectionId,
              account.creditsMonthly == null ? "" : String(account.creditsMonthly),
            ])
          ));
        }
      })
      .catch((error) => console.log("Error fetching data:", error))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchActivity();
  }, [fetchActivity]);

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;

    const toLimit = (value) => value === "" ? null : Number(value);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newKeyName,
          inputTokensMonthly: toLimit(newInputTokensMonthly),
          outputTokensMonthly: toLimit(newOutputTokensMonthly),
          creditsMonthly: toLimit(newCreditsMonthly),
        }),
      });
      const data = await res.json();

      if (res.ok) {
        setCreatedKeyMode("created");
        setCreatedKey(data.key);
        await fetchData();
        setNewKeyName("");
        setNewInputTokensMonthly("");
        setNewOutputTokensMonthly("");
        setNewCreditsMonthly("");
        setShowAddModal(false);
      }
    } catch (error) {
      console.log("Error creating key:", error);
    }
  };

  const handleDeleteKey = async (id) => {
    setConfirmState({
      title: "Delete API Key",
      message: "Delete this API key?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}`, { method: "DELETE" });
          if (res.ok) {
            setKeys(keys.filter((k) => k.id !== id));
            setVisibleKeys(prev => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }
        } catch (error) {
          console.log("Error deleting key:", error);
        }
      }
    });
  };

  const handleToggleKey = async (id, isActive) => {
    try {
      const res = await fetch(`/api/keys/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive }),
      });
      if (res.ok) {
        setKeys(prev => prev.map(k => k.id === id ? { ...k, isActive } : k));
      }
    } catch (error) {
      console.log("Error toggling key:", error);
    }
  };

  const handleResetKeyUsage = async (id) => {
    try {
      const res = await fetch(`/api/keys/${id}/reset-usage`, { method: "POST" });
      if (res.ok) await fetchData();
    } catch (error) {
      console.log("Error resetting key usage:", error);
    }
  };

  const showBudgetStatus = (scope, type, message) => {
    clearTimeout(budgetStatusTimer.current);
    const status = { scope, type, message };
    setBudgetStatus(status);
    if (type === "success") {
      budgetStatusTimer.current = setTimeout(() => {
        setBudgetStatus((current) => (current === status ? null : current));
      }, BUDGET_STATUS_CLEAR_MS);
    }
  };

  const handleSaveTeamBudget = async () => {
    const inputs = {
      inputTokensMonthly: teamInputTokensMonthly,
      outputTokensMonthly: teamOutputTokensMonthly,
      creditsMonthly: teamCreditsMonthly,
    };
    const payload = {};
    for (const { field, label } of TEAM_BUDGET_FIELDS) {
      const parsed = parseBudgetInput(inputs[field], label);
      if (parsed.error) return showBudgetStatus("team", "error", parsed.error);
      payload[field] = parsed.value;
    }
    try {
      const res = await fetch("/api/team/budget", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return showBudgetStatus("team", "error", data.error || "Failed to save team budget");
      }
      await fetchData();
      showBudgetStatus("team", "success", "Team budget saved");
    } catch (error) {
      console.log("Error saving team budget:", error);
      showBudgetStatus("team", "error", "Failed to save team budget");
    }
  };

  const handleResetTeamUsage = async () => {
    setConfirmState({
      title: "Reset Team Usage",
      message: "Reset all Team Kiro usage for every period?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch("/api/team/budget/reset-usage", { method: "POST" });
          if (!res.ok) return showBudgetStatus("team", "error", "Failed to reset team usage");
          await fetchData();
          showBudgetStatus("team", "success", "Team usage reset");
        } catch (error) {
          console.log("Error resetting team usage:", error);
          showBudgetStatus("team", "error", "Failed to reset team usage");
        }
      },
    });
  };

  const handleSaveAccountBudget = async (connectionId) => {
    const parsed = parseBudgetInput(accountCreditsMonthly[connectionId] ?? "", "Monthly Kiro credits");
    if (parsed.error) return showBudgetStatus(connectionId, "error", parsed.error);
    try {
      const res = await fetch(`/api/kiro/accounts/${encodeURIComponent(connectionId)}/budget`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ creditsMonthly: parsed.value }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return showBudgetStatus(connectionId, "error", data.error || "Failed to save account budget");
      }
      await fetchData();
      showBudgetStatus(connectionId, "success", "Account budget saved");
    } catch (error) {
      console.log("Error saving account budget:", error);
      showBudgetStatus(connectionId, "error", "Failed to save account budget");
    }
  };

  const handleResetAccountUsage = async (connectionId) => {
    setConfirmState({
      title: "Reset Account Usage",
      message: "Reset all usage for this Kiro account?",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/kiro/accounts/${encodeURIComponent(connectionId)}/reset-usage`, { method: "POST" });
          if (!res.ok) return showBudgetStatus(connectionId, "error", "Failed to reset account usage");
          await fetchData();
          showBudgetStatus(connectionId, "success", "Account usage reset");
        } catch (error) {
          console.log("Error resetting account usage:", error);
          showBudgetStatus(connectionId, "error", "Failed to reset account usage");
        }
      },
    });
  };

  const handleRotateKey = async (id) => {
    setConfirmState({
      title: "Rotate API Key",
      message: "Rotate this API key? The current key will stop working immediately.",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          const res = await fetch(`/api/keys/${id}/rotate`, { method: "POST" });
          if (res.ok) {
            const data = await res.json();
            setCreatedKeyMode("rotated");
            setCreatedKey(data.key);
            await fetchData();
          }
        } catch (error) {
          console.log("Error rotating API key:", error);
        }
      },
    });
  };

  const maskKey = (fullKey) => {
    if (!fullKey || fullKey.length <= 10) return fullKey || "";
    return fullKey.slice(0, 6) + "•".repeat(fullKey.length - 10) + fullKey.slice(-4);
  };

  const toggleKeyVisibility = (keyId) => {
    setVisibleKeys(prev => {
      const next = new Set(prev);
      if (next.has(keyId)) next.delete(keyId);
      else next.add(keyId);
      return next;
    });
  };


  const teamPolicy = teamBudget?.policy || {};
  const teamUsage = teamBudget?.usage || {};
  const teamFieldValues = {
    inputTokensMonthly: teamInputTokensMonthly,
    outputTokensMonthly: teamOutputTokensMonthly,
    creditsMonthly: teamCreditsMonthly,
  };
  const teamFieldSetters = {
    inputTokensMonthly: setTeamInputTokensMonthly,
    outputTokensMonthly: setTeamOutputTokensMonthly,
    creditsMonthly: setTeamCreditsMonthly,
  };
  // Dimensions at or past the warning thresholds, for the team card alert.
  const teamWarnings = TEAM_BUDGET_FIELDS
    .map(({ field, usage, short }) => ({ short, level: usageLevel(teamUsage[usage] || 0, teamPolicy[field]) }))
    .filter(({ level }) => level?.level);
  const poolTotals = kiroAccounts.reduce((totals, account) => {
    totals.credits += account.credits || 0;
    if (account.creditsMonthly == null) totals.unlimited = true;
    else totals.ceiling += account.creditsMonthly;
    return totals;
  }, { credits: 0, ceiling: 0, unlimited: false });
  const memberTotals = keys.reduce((totals, key) => {
    totals.inputTokens += key.usage?.inputTokens || 0;
    totals.outputTokens += key.usage?.outputTokens || 0;
    totals.credits += key.usage?.credits || 0;
    return totals;
  }, { inputTokens: 0, outputTokens: 0, credits: 0 });

  return (
    <div className="flex flex-col gap-8">
      <SegmentedControl
        options={[
          { value: "management", label: "Management" },
          { value: "analytics", label: "Analytics" },
        ]}
        value={tab}
        onChange={handleTabChange}
        className="w-full sm:w-auto"
      />

      {tab === "analytics" ? (
        <TeamAnalytics keys={keys} />
      ) : loading ? (
        <div className="flex flex-col gap-8">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      ) : (
        <>
      {/* Members (API keys) */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">vpn_key</span>
            Members (API keys)
          </h2>
          <Button icon="add" onClick={() => setShowAddModal(true)}>
            Create Key
          </Button>
        </div>

        {keys.length === 0 ? (
          <div className="text-center py-12">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
              <span className="material-symbols-outlined text-[32px]">vpn_key</span>
            </div>
            <p className="text-text-main font-medium mb-1">No API keys yet</p>
            <p className="text-sm text-text-muted mb-4">Create your first API key to get started</p>
            <Button icon="add" onClick={() => setShowAddModal(true)}>
              Create Key
            </Button>
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="flex items-center justify-end pb-2">
              <SegmentedControl
                options={PERIODS}
                value={activityPeriod}
                onChange={setActivityPeriod}
                size="sm"
              />
            </div>
            {keys.map((key) => {
              const activity = activityByKey[key.name];
              return (
                <div
                  key={key.id}
                  className={`group flex items-center justify-between py-3 border-b border-black/[0.03] dark:border-white/[0.03] last:border-b-0 ${key.isActive === false ? "opacity-60" : ""}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{key.name}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <code className="text-xs text-text-muted font-mono">
                        {visibleKeys.has(key.id) ? key.key : maskKey(key.key)}
                      </code>
                      <button
                        onClick={() => toggleKeyVisibility(key.id)}
                        className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all"
                        title={visibleKeys.has(key.id) ? "Hide key" : "Show key"}
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {visibleKeys.has(key.id) ? "visibility_off" : "visibility"}
                        </span>
                      </button>
                      <button
                        onClick={() => copy(key.key, key.id)}
                        className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded text-text-muted hover:text-primary transition-all"
                      >
                        <span className="material-symbols-outlined text-[14px]">
                          {copied === key.id ? "check" : "content_copy"}
                        </span>
                      </button>
                    </div>
                    <p className="text-xs text-text-muted mt-1">
                      Created {new Date(key.createdAt).toLocaleDateString()}
                    </p>
                    {key.isActive === false && (
                      <p className="text-xs text-orange-500 mt-1">Paused</p>
                    )}
                    <p className="text-xs text-text-muted mt-1">
                      Monthly usage: In {fmtNum(key.usage?.inputTokens || 0)} / {key.inputTokensMonthly == null ? "unlimited" : fmtNum(key.inputTokensMonthly)}{remainingHint(key.usage?.inputTokens || 0, key.inputTokensMonthly)}
                      {" · "}Out {fmtNum(key.usage?.outputTokens || 0)} / {key.outputTokensMonthly == null ? "unlimited" : fmtNum(key.outputTokensMonthly)}{remainingHint(key.usage?.outputTokens || 0, key.outputTokensMonthly)}
                      {" · "}Credits {fmtNum(key.usage?.credits || 0)} / {key.creditsMonthly == null ? "unlimited" : fmtNum(key.creditsMonthly)}{remainingHint(key.usage?.credits || 0, key.creditsMonthly)}
                    </p>
                    <p className="text-xs text-text-muted mt-0.5">
                      Activity ({activityPeriod}, all providers): {fmtNum(activity?.requests || 0)} req
                      {" · "}{fmtNum((activity?.promptTokens || 0) + (activity?.completionTokens || 0))} tokens
                      {" · "}{fmtCost(activity?.cost || 0)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Toggle
                      size="sm"
                      checked={key.isActive ?? true}
                      onChange={(checked) => {
                        if (key.isActive && !checked) {
                          setConfirmState({
                            title: "Pause API Key",
                            message: `Pause API key "${key.name}"?\n\nThis key will stop working immediately but can be resumed later.`,
                            onConfirm: async () => {
                              setConfirmState(null);
                              handleToggleKey(key.id, checked);
                            }
                          });
                        } else {
                          handleToggleKey(key.id, checked);
                        }
                      }}
                      title={key.isActive ? "Pause key" : "Resume key"}
                    />
                    <Button
                      variant="ghost"
                      icon="restart_alt"
                      onClick={() => handleResetKeyUsage(key.id)}
                      title="Reset usage"
                    >
                      <span className="hidden sm:inline">Reset usage</span>
                    </Button>
                    <Button
                      variant="ghost"
                      icon="autorenew"
                      onClick={() => handleRotateKey(key.id)}
                      title="Rotate key"
                    >
                      <span className="hidden sm:inline">Rotate</span>
                    </Button>
                    <button
                      onClick={() => handleDeleteKey(key.id)}
                      className="p-2 hover:bg-red-500/10 rounded text-red-500 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Team Kiro Budget */}
      <Card>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">account_balance</span>
          Team Kiro Budget
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {TEAM_BUDGET_FIELDS.map(({ field, usage, label, step }) => (
            <Input
              key={field}
              label={label}
              type="number"
              min="0"
              step={step}
              value={teamFieldValues[field]}
              onChange={(e) => teamFieldSetters[field](e.target.value)}
              placeholder="Unlimited"
              hint={usageHint(teamUsage[usage] || 0, teamPolicy[field])}
            />
          ))}
        </div>
        {teamWarnings.length > 0 && (
          <StatusAlert
            className="mt-4"
            status={{
              type: teamWarnings.some(({ level }) => level.level !== "warning") ? "error" : "warning",
              message: teamWarnings
                .map(({ short, level }) => (level.level === "exhausted"
                  ? `${short}: monthly team limit reached — Kiro requests are rejected until usage is reset or the limit is raised`
                  : `${short}: ${level.pct}% of the monthly team limit used`))
                .join(" · "),
            }}
          />
        )}
        <div className="flex items-center gap-2 mt-4">
          <Button onClick={handleSaveTeamBudget} icon="save">Save</Button>
          <Button
            variant="ghost"
            icon="restart_alt"
            onClick={handleResetTeamUsage}
            title="Reset team usage"
          >
            <span className="hidden sm:inline">Reset usage</span>
          </Button>
        </div>
        {budgetStatus?.scope === "team" && <StatusAlert className="mt-3" status={budgetStatus} />}
      </Card>

      {/* Kiro Account Pool */}
      <Card>
        <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">group_work</span>
          Kiro account pool
        </h2>
        <p className="text-xs text-text-muted mb-4">
          Pool total: {fmtNum(poolTotals.credits)} / {poolTotals.unlimited ? "unlimited" : fmtNum(poolTotals.ceiling)} credits
          {" · "}{kiroAccounts.length} account{kiroAccounts.length === 1 ? "" : "s"}
          <br />
          Member total: In {fmtNum(memberTotals.inputTokens)}
          {" · "}Out {fmtNum(memberTotals.outputTokens)}
          {" · "}Credits {fmtNum(memberTotals.credits)}
          {" · "}{keys.length} API key{keys.length === 1 ? "" : "s"}
        </p>
        {kiroAccounts.length === 0 ? (
          <p className="text-sm text-text-muted py-6 text-center">
            No active Kiro accounts connected.{" "}
            <Link href="/dashboard/providers/kiro" className="font-medium underline hover:opacity-80">
              Connect a Kiro account
            </Link>
          </p>
        ) : (
          <div className="flex flex-col">
            {kiroAccounts.map((account) => (
              <div
                key={account.connectionId}
                className="flex flex-col gap-3 py-4 border-b border-black/[0.03] dark:border-white/[0.03] last:border-b-0"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium truncate">{account.name}</p>
                      {account.testStatus && (
                        <Badge size="sm" dot variant={getStatusVariant(true, account.testStatus)}>
                          {account.testStatus}
                        </Badge>
                      )}
                      <UsageBadge used={account.credits || 0} limit={account.creditsMonthly} />
                    </div>
                    <p className="text-xs text-text-muted mt-1">
                      {usageHint(account.credits || 0, account.creditsMonthly)} credits
                    </p>
                    {account.lastError && getStatusVariant(true, account.testStatus) === "error" && (
                      <p className="text-xs text-red-500 mt-1 truncate" title={account.lastError}>{account.lastError}</p>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    icon="restart_alt"
                    onClick={() => handleResetAccountUsage(account.connectionId)}
                    title="Reset account usage"
                  >
                    <span className="hidden sm:inline">Reset usage</span>
                  </Button>
                </div>
                <div className="flex items-end gap-2">
                  <Input
                    className="flex-1"
                    label="Monthly Kiro credits"
                    type="number"
                    min="0"
                    step="0.01"
                    value={accountCreditsMonthly[account.connectionId] ?? ""}
                    onChange={(e) => setAccountCreditsMonthly((previous) => ({
                      ...previous,
                      [account.connectionId]: e.target.value,
                    }))}
                    placeholder="Unlimited"
                  />
                  <Button onClick={() => handleSaveAccountBudget(account.connectionId)} icon="save">
                    Save
                  </Button>
                </div>
                {budgetStatus?.scope === account.connectionId && <StatusAlert status={budgetStatus} />}
              </div>
            ))}
          </div>
        )}
      </Card>

        </>
      )}

      {/* Add Key Modal */}
      <Modal
        isOpen={showAddModal}
        title="Create API Key"
        onClose={() => {
          setShowAddModal(false);
          setNewKeyName("");
          setNewInputTokensMonthly("");
          setNewOutputTokensMonthly("");
          setNewCreditsMonthly("");
        }}
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Key Name"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            placeholder="Production Key"
          />
          <Input
            label="Monthly input token limit"
            type="number"
            min="0"
            value={newInputTokensMonthly}
            onChange={(e) => setNewInputTokensMonthly(e.target.value)}
            placeholder="Unlimited"
          />
          <Input
            label="Monthly output token limit"
            type="number"
            min="0"
            value={newOutputTokensMonthly}
            onChange={(e) => setNewOutputTokensMonthly(e.target.value)}
            placeholder="Unlimited"
          />
          <Input
            label="Monthly Kiro credit limit"
            type="number"
            min="0"
            step="0.01"
            value={newCreditsMonthly}
            onChange={(e) => setNewCreditsMonthly(e.target.value)}
            placeholder="Unlimited"
          />
          <div className="flex gap-2">
            <Button onClick={handleCreateKey} fullWidth disabled={!newKeyName.trim()}>
              Create
            </Button>
            <Button
              onClick={() => {
                setShowAddModal(false);
                setNewKeyName("");
                setNewInputTokensMonthly("");
                setNewOutputTokensMonthly("");
                setNewCreditsMonthly("");
              }}
              variant="ghost"
              fullWidth
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>

      {/* Created / Rotated Key Modal */}
      <Modal
        isOpen={!!createdKey}
        title={createdKeyMode === "rotated" ? "API Key Rotated" : "API Key Created"}
        onClose={() => setCreatedKey(null)}
      >
        <div className="flex flex-col gap-4">
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
            <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2 font-medium">
              Save this key now!
            </p>
            <p className="text-sm text-yellow-700 dark:text-yellow-300">
              {createdKeyMode === "rotated"
                ? "The previous key stopped working immediately. Update every client that used it — this is the only time you will see the new key."
                : "This is the only time you will see this key. Store it securely."}
            </p>
          </div>
          <div className="flex gap-2">
            <Input
              value={createdKey || ""}
              readOnly
              className="flex-1 font-mono text-sm"
            />
            <Button
              variant="secondary"
              icon={copied === "created_key" ? "check" : "content_copy"}
              onClick={() => copy(createdKey, "created_key")}
            >
              {copied === "created_key" ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button onClick={() => setCreatedKey(null)} fullWidth>
            Done
          </Button>
        </div>
      </Modal>

      {/* Confirm Modal */}
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={() => setConfirmState(null)}
        onConfirm={confirmState?.onConfirm}
        title={confirmState?.title || "Confirm"}
        message={confirmState?.message}
        variant="danger"
      />
    </div>
  );
}
