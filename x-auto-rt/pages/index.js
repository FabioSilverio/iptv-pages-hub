import { useState, useEffect } from "react";
import Head from "next/head";

export default function Home() {
  const [config, setConfig] = useState(null);
  const [targetUserId, setTargetUserId] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [connection, setConnection] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => {
        setConfig(data);
        setTargetUserId(data.targetUserId || "");
        setEnabled(data.enabled || false);
      });

    fetch("/api/test-connection")
      .then((r) => r.json())
      .then((data) => setConnection(data));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, targetUserId }),
    });
    const data = await res.json();
    setConfig(data);
    setSaving(false);
  };

  return (
    <>
      <Head>
        <title>X Auto-Retweet</title>
      </Head>
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.title}>X Auto-Retweet</h1>

          <div style={styles.statusSection}>
            <div
              style={{
                ...styles.badge,
                backgroundColor: connection?.connected ? "#10b981" : "#ef4444",
              }}
            >
              {connection?.connected
                ? `Conectado como @${connection.username}`
                : "Nao conectado - verifique suas chaves da API"}
            </div>
            <div
              style={{
                ...styles.badge,
                backgroundColor: enabled ? "#10b981" : "#6b7280",
              }}
            >
              {enabled ? "AUTO-RT ATIVO" : "AUTO-RT DESATIVADO"}
            </div>
          </div>

          <div style={styles.section}>
            <label style={styles.label}>
              ID da conta alvo (usuario que sera retuitado)
            </label>
            <input
              type="text"
              value={targetUserId}
              onChange={(e) => setTargetUserId(e.target.value)}
              placeholder="Ex: 1234567890"
              style={styles.input}
            />
            <p style={styles.hint}>
              Para descobrir o ID: use{" "}
              <a
                href="https://tweeterid.com/"
                target="_blank"
                style={{ color: "#3b82f6" }}
              >
                tweeterid.com
              </a>
            </p>
          </div>

          <div style={styles.section}>
            <label style={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                style={styles.checkbox}
              />
              Ativar retweet automatico
            </label>
          </div>

          <button onClick={handleSave} disabled={saving} style={styles.button}>
            {saving ? "Salvando..." : "Salvar e Ativar"}
          </button>

          {config && config.totalRetweets > 0 && (
            <div style={styles.stats}>
              <h3 style={styles.statsTitle}>Estatisticas</h3>
              <div style={styles.statsGrid}>
                <div style={styles.statItem}>
                  <span style={styles.statValue}>{config.totalRetweets}</span>
                  <span style={styles.statLabel}>Retweets feitos</span>
                </div>
                <div style={styles.statItem}>
                  <span style={styles.statValue}>
                    {config.lastRetweetedAt
                      ? new Date(config.lastRetweetedAt).toLocaleString("pt-BR")
                      : "-"}
                  </span>
                  <span style={styles.statLabel}>Ultimo retweet</span>
                </div>
                {config.lastRetweetedTweetText && (
                  <div style={styles.statItem}>
                    <span style={styles.statTweet}>
                      {config.lastRetweetedTweetText}...
                    </span>
                    <span style={styles.statLabel}>Ultimo tweet retuitado</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const styles = {
  container: {
    minHeight: "100vh",
    backgroundColor: "#0f172a",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  card: {
    backgroundColor: "#1e293b",
    borderRadius: "16px",
    padding: "32px",
    width: "100%",
    maxWidth: "500px",
    boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.5)",
  },
  title: {
    color: "#f8fafc",
    fontSize: "28px",
    fontWeight: "bold",
    marginBottom: "24px",
    textAlign: "center",
  },
  statusSection: {
    display: "flex",
    gap: "12px",
    justifyContent: "center",
    marginBottom: "24px",
    flexWrap: "wrap",
  },
  badge: {
    color: "#fff",
    padding: "6px 16px",
    borderRadius: "9999px",
    fontSize: "12px",
    fontWeight: "600",
    letterSpacing: "0.5px",
  },
  section: {
    marginBottom: "20px",
  },
  label: {
    display: "block",
    color: "#94a3b8",
    fontSize: "14px",
    marginBottom: "8px",
  },
  input: {
    width: "100%",
    padding: "12px 16px",
    backgroundColor: "#0f172a",
    border: "1px solid #334155",
    borderRadius: "8px",
    color: "#f8fafc",
    fontSize: "16px",
    outline: "none",
    boxSizing: "border-box",
  },
  hint: {
    color: "#64748b",
    fontSize: "12px",
    marginTop: "6px",
  },
  toggleLabel: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    color: "#f8fafc",
    fontSize: "16px",
    cursor: "pointer",
  },
  checkbox: {
    width: "20px",
    height: "20px",
    cursor: "pointer",
  },
  button: {
    width: "100%",
    padding: "14px",
    backgroundColor: "#3b82f6",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "16px",
    fontWeight: "600",
    cursor: "pointer",
    marginTop: "8px",
  },
  stats: {
    marginTop: "24px",
    padding: "20px",
    backgroundColor: "#0f172a",
    borderRadius: "12px",
  },
  statsTitle: {
    color: "#f8fafc",
    fontSize: "16px",
    marginBottom: "16px",
  },
  statsGrid: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  statItem: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
  },
  statValue: {
    color: "#f8fafc",
    fontSize: "18px",
    fontWeight: "600",
  },
  statLabel: {
    color: "#64748b",
    fontSize: "12px",
  },
  statTweet: {
    color: "#94a3b8",
    fontSize: "14px",
    fontStyle: "italic",
  },
};
