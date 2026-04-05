export default function Home() {
  const filingExamples = [
    { label: "Recent Form 4 (insider transactions)", href: "/api/filings?type=4" },
    { label: "Form 4 for AAPL", href: "/api/filings?type=4&ticker=AAPL" },
    { label: "Recent 8-K (material events)", href: "/api/filings?type=8-K" },
    { label: "13F (institutional holdings)", href: "/api/filings?type=13F" },
  ];

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px" }}>
      <h1 style={{ fontSize: 32, marginBottom: 8 }}>Investment Seeker</h1>
      <p style={{ color: "#9aa4ad", marginTop: 0 }}>
        SEC EDGAR insider trading monitor with AI-powered analysis.
      </p>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>Endpoints</h2>

      <h3 style={{ fontSize: 16, marginTop: 24, color: "#7cc4ff" }}>
        GET /api/filings
      </h3>
      <p style={{ color: "#9aa4ad", fontSize: 14 }}>
        Search recent SEC filings from EDGAR.
      </p>
      <pre
        style={{
          background: "#14171c",
          padding: 16,
          borderRadius: 8,
          overflowX: "auto",
        }}
      >
        /api/filings?type=&lt;4|8-K|13F&gt;&amp;ticker=&lt;TICKER&gt;&amp;limit=&lt;1-100&gt;
      </pre>

      <h3 style={{ fontSize: 16, marginTop: 24, color: "#7cc4ff" }}>
        GET /api/summarize
      </h3>
      <p style={{ color: "#9aa4ad", fontSize: 14 }}>
        AI-powered filing summarizer. Uses Haiku by default, Sonnet for deep
        analysis.
      </p>
      <pre
        style={{
          background: "#14171c",
          padding: 16,
          borderRadius: 8,
          overflowX: "auto",
        }}
      >
        /api/summarize?url=&lt;SEC_FILING_URL&gt;&amp;deep_analysis=&lt;true|false&gt;
      </pre>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>Try it</h2>
      <ul>
        {filingExamples.map((e) => (
          <li key={e.href} style={{ margin: "6px 0" }}>
            <a href={e.href} style={{ color: "#7cc4ff" }}>
              {e.label}
            </a>
          </li>
        ))}
      </ul>

      <h2 style={{ fontSize: 20, marginTop: 32 }}>Libraries</h2>
      <ul style={{ color: "#9aa4ad", fontSize: 14, lineHeight: 1.8 }}>
        <li>
          <strong style={{ color: "#e6e8eb" }}>parseForm4</strong> — Parse Form
          4 XML into structured insider transaction data
        </li>
        <li>
          <strong style={{ color: "#e6e8eb" }}>scoreSignal</strong> — Score
          insider transactions 0-100 based on cluster buying, insider role, purchase
          type, relative holdings, and price dip signals
        </li>
        <li>
          <strong style={{ color: "#e6e8eb" }}>costs</strong> — Estimate
          Anthropic API costs from token usage
        </li>
      </ul>

      <p style={{ color: "#9aa4ad", fontSize: 13, marginTop: 32 }}>
        SEC requests are rate-limited to 10/sec per instance with a descriptive
        User-Agent as required by SEC fair access policy. AI summaries are cached
        in Supabase.
      </p>
    </main>
  );
}
