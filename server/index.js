/**
 * Claira API server (deployed from repo root; Render / external integrations).
 * CommonJS so this runs with root package.json (no "type": "module").
 */
const express = require("express");

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "claira",
  });
});

app.post("/run", (req, res) => {
  const body = req.body ?? {};
  res.json({
    message: "Claira API connected",
    received: body,
  });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Claira server running on port ${port}`);
});
