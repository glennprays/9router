"use client";

import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { Badge, Button, ConfirmModal, Input, Modal, Select } from "@/shared/components";
import StatusAlert from "../endpoint/components/StatusAlert";

const LIMIT_FIELDS = [
  { field: "inputTokensMonthly", usage: "inputTokens", label: "Input tokens / month" },
  { field: "outputTokensMonthly", usage: "outputTokens", label: "Output tokens / month" },
  { field: "creditsMonthly", usage: "credits", label: "Kiro credits / month" },
];

function toInput(value) {
  return value == null ? "" : String(value);
}

function toNumber(value) {
  if (value === "" || value == null) return null;
  return Number(value);
}

function hasLimit(row) {
  return row.inputTokensMonthly != null
    || row.outputTokensMonthly != null
    || row.creditsMonthly != null;
}

function metricHint(row, field) {
  const used = Number(row.usage?.[field.usage] || 0);
  const limit = row[field.field];
  if (limit == null) return `Used ${used.toLocaleString()} · Unlimited`;
  return `Used ${used.toLocaleString()} / ${Number(limit).toLocaleString()} · Remaining ${Math.max(0, Number(limit) - used).toLocaleString()}`;
}

function UsageBadge({ row }) {
  const levels = LIMIT_FIELDS
    .map(({ field, usage }) => {
      const limit = row[field];
      if (limit == null) return null;
      const used = Number(row.usage?.[usage] || 0);
      const pct = Number(limit) > 0 ? (used / Number(limit)) * 100 : 100;
      return { pct, exhausted: pct >= 100 };
    })
    .filter(Boolean);
  if (levels.length === 0) return null;
  const highest = levels.reduce((a, b) => (b.pct > a.pct ? b : a));
  if (highest.exhausted) return <Badge size="sm" variant="error" icon="block">Exhausted</Badge>;
  if (highest.pct >= 90) return <Badge size="sm" variant="error" icon="warning">{Math.round(highest.pct)}% used</Badge>;
  if (highest.pct >= 80) return <Badge size="sm" variant="warning" icon="warning">{Math.round(highest.pct)}% used</Badge>;
  return null;
}

UsageBadge.propTypes = { row: PropTypes.object.isRequired };

function seedRows(keyData) {
  return (keyData?.providerBudgets || []).map((row) => ({
    provider: row.provider,
    inputTokensMonthly: toInput(row.inputTokensMonthly),
    outputTokensMonthly: toInput(row.outputTokensMonthly),
    creditsMonthly: toInput(row.creditsMonthly),
    usage: row.usage || { inputTokens: 0, outputTokens: 0, credits: 0 },
  }));
}

export default function ApiKeyBudgetModal({
  isOpen,
  mode = "create",
  keyData,
  routableProviders = [],
  onClose,
  onSaved,
  onCreated,
}) {
  const [name, setName] = useState(() => keyData?.name || "");
  const [global, setGlobal] = useState(() => ({
    inputTokensMonthly: toInput(keyData?.inputTokensMonthly),
    outputTokensMonthly: toInput(keyData?.outputTokensMonthly),
    creditsMonthly: toInput(keyData?.creditsMonthly),
  }));
  const [rows, setRows] = useState(() => seedRows(keyData));
  const [selectedProvider, setSelectedProvider] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetProvider, setResetProvider] = useState(null);


  const availableProviders = useMemo(() => {
    const existing = new Set(rows.map((row) => row.provider));
    return routableProviders
      .filter((provider) => !existing.has(provider.id))
      .map((provider) => ({ value: provider.id, label: provider.name || provider.id }));
  }, [routableProviders, rows]);

  const updateGlobal = (field, value) => setGlobal((current) => ({ ...current, [field]: value }));
  const updateRow = (provider, field, value) => {
    setRows((current) => current.map((row) => row.provider === provider ? { ...row, [field]: value } : row));
  };

  const addProvider = () => {
    if (!selectedProvider) return;
    setRows((current) => [...current, {
      provider: selectedProvider,
      inputTokensMonthly: "",
      outputTokensMonthly: "",
      creditsMonthly: "",
      usage: { inputTokens: 0, outputTokens: 0, credits: 0 },
    }]);
    setSelectedProvider("");
  };

  const resetCurrentProvider = async () => {
    if (!resetProvider || !keyData?.id) return;
    const provider = resetProvider.provider;
    try {
      const response = await fetch(`/api/keys/${encodeURIComponent(keyData.id)}/providers/${encodeURIComponent(provider)}/reset-usage`, { method: "POST" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to reset provider usage");
      }
      setRows((current) => current.map((row) => row.provider === provider
        ? { ...row, usage: { ...(row.usage || {}), inputTokens: 0, outputTokens: 0, credits: 0 } }
        : row));
      setResetProvider(null);
      await onSaved?.();
    } catch (resetError) {
      setResetProvider(null);
      setError(resetError.message);
    }
  };

  const save = async () => {
    if (mode === "create" && !name.trim()) {
      setError("Key name is required");
      return;
    }
    setSaving(true);
    setError("");
    const payload = {
      ...(mode === "create" ? { name: name.trim() } : {}),
      ...Object.fromEntries(LIMIT_FIELDS.map(({ field }) => [field, toNumber(global[field])])),
      providerBudgets: rows.map((row) => ({
        provider: row.provider,
        inputTokensMonthly: toNumber(row.inputTokensMonthly),
        outputTokensMonthly: toNumber(row.outputTokensMonthly),
        creditsMonthly: row.provider === "kiro" ? toNumber(row.creditsMonthly) : null,
      })),
    };
    try {
      const response = await fetch(mode === "create" ? "/api/keys" : `/api/keys/${encodeURIComponent(keyData.id)}`, {
        method: mode === "create" ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to save API key limits");
      if (mode === "create") await onCreated?.(data);
      else await onSaved?.(data);
      onClose();
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title={mode === "create" ? "Create API key" : `Edit limits · ${keyData?.name || "API key"}`}
        size="full"
      >
        <div className="flex flex-col gap-6">
          {error && <StatusAlert status={{ type: "error", message: error }} />}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {mode === "create" && (
              <Input label="Key name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Production key" />
            )}
            {mode !== "create" && (
              <Input label="Key name" value={name} disabled hint="Key names are not changed from the limits editor" />
            )}
            {LIMIT_FIELDS.map(({ field, label }) => (
              <Input
                key={field}
                label={label}
                type="number"
                min="0"
                step={field === "creditsMonthly" ? "0.01" : "1"}
                value={global[field]}
                onChange={(event) => updateGlobal(field, event.target.value)}
                placeholder="Unlimited"
              />
            ))}
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-end gap-2">
              <Select
                className="flex-1"
                label="Provider limits"
                options={availableProviders}
                value={selectedProvider}
                onChange={(event) => setSelectedProvider(event.target.value)}
                placeholder={availableProviders.length ? "Select a routable provider" : "All routable providers added"}
              />
              <Button variant="secondary" icon="add" onClick={addProvider} disabled={!selectedProvider}>Add provider limit</Button>
            </div>
            <p className="text-xs text-text-muted">
              Token limits apply to this provider. Kiro credits are available only for Kiro.
              Removing a row clears its policy but keeps recorded usage.
            </p>

            {rows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border-subtle p-5 text-sm text-text-muted text-center">
                No provider-specific limits configured.
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {rows.map((row) => (
                  <div key={row.provider} className="rounded-lg border border-border-subtle p-4">
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{routableProviders.find((item) => item.id === row.provider)?.name || row.provider}</span>
                        <UsageBadge row={row} />
                        {!hasLimit(row) && <Badge size="sm">Usage only</Badge>}
                      </div>
                      <div className="flex items-center gap-2">
                        {keyData?.id && (
                          <Button variant="ghost" icon="restart_alt" onClick={() => setResetProvider(row)} title="Reset current provider usage">
                            <span className="hidden sm:inline">Reset usage</span>
                          </Button>
                        )}
                        <Button variant="ghost" icon="delete" onClick={() => setRows((current) => current.filter((item) => item.provider !== row.provider))} title="Remove provider limit">
                          <span className="hidden sm:inline">Remove</span>
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <Input label="Input tokens / month" type="number" min="0" value={row.inputTokensMonthly} onChange={(event) => updateRow(row.provider, "inputTokensMonthly", event.target.value)} placeholder="Unlimited" hint={metricHint(row, LIMIT_FIELDS[0])} />
                      <Input label="Output tokens / month" type="number" min="0" value={row.outputTokensMonthly} onChange={(event) => updateRow(row.provider, "outputTokensMonthly", event.target.value)} placeholder="Unlimited" hint={metricHint(row, LIMIT_FIELDS[1])} />
                      {row.provider === "kiro" ? (
                        <Input label="Kiro credits / month" type="number" min="0" step="0.01" value={row.creditsMonthly} onChange={(event) => updateRow(row.provider, "creditsMonthly", event.target.value)} placeholder="Unlimited" hint={metricHint(row, LIMIT_FIELDS[2])} />
                      ) : (
                        <div className="flex items-center text-xs text-text-muted">Kiro credits do not apply to this provider.</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={save} loading={saving}>{mode === "create" ? "Create key" : "Save limits"}</Button>
          </div>
        </div>
      </Modal>
      <ConfirmModal
        isOpen={!!resetProvider}
        onClose={() => setResetProvider(null)}
        onConfirm={resetCurrentProvider}
        title="Reset provider usage"
        message={resetProvider ? `Reset current-month ${resetProvider.provider} usage for this key? Prior periods and usage history remain unchanged.` : ""}
        confirmText="Reset usage"
      />
    </>
  );
}

ApiKeyBudgetModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  mode: PropTypes.oneOf(["create", "edit"]),
  keyData: PropTypes.object,
  routableProviders: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string, name: PropTypes.string })),
  onClose: PropTypes.func.isRequired,
  onSaved: PropTypes.func,
  onCreated: PropTypes.func,
};
