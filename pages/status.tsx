"use client";

import { Button, Card } from "@spacefast/zero/kit";
import { useState } from "preact/hooks";

export default function StatusPage() {
  const [status, setStatus] = useState("not checked yet");
  async function checkStatus() {
    const response = await fetch("/api/status");
    setStatus(response.ok ? await response.text() : "error " + response.status);
  }
  return (
    <Card title="Status" subtitle="Calls this capsule's GET /api/status endpoint.">
      <div class="flex items-center gap-3">
        <Button variant="secondary" onClick={() => void checkStatus()}>
          Check endpoint
        </Button>
        <span class="text-sm text-ink-muted">{status}</span>
      </div>
    </Card>
  );
}

