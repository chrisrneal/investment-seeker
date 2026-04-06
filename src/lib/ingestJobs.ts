// In-memory job store for tracking ingestion progress.
// Jobs survive across client disconnects but not server restarts.

export type JobStepStatus = "pending" | "active" | "done" | "error";

export type JobStep = {
  label: string;
  status: JobStepStatus;
  detail?: string;
  progress?: { current: number; total: number };
};

export type JobStatus = "running" | "completed" | "failed";

export type IngestJob = {
  id: string;
  status: JobStatus;
  steps: JobStep[];
  currentStep: number;
  error?: string;
  result?: Record<string, unknown>;
  startedAt: number;
  updatedAt: number;
};

const jobs = new Map<string, IngestJob>();
const JOB_TTL_MS = 60 * 60 * 1000; // Clean up after 1 hour

function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

export function createJob(id: string, stepLabels: string[]): IngestJob {
  cleanup();
  const job: IngestJob = {
    id,
    status: "running",
    steps: stepLabels.map((label) => ({ label, status: "pending" })),
    currentStep: -1,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): IngestJob | undefined {
  return jobs.get(id);
}

export function findRunningJob(): IngestJob | undefined {
  for (const job of jobs.values()) {
    if (job.status === "running") return job;
  }
  return undefined;
}

export function advanceStep(id: string, detail?: string) {
  const job = jobs.get(id);
  if (!job) return;
  // Mark previous step done
  if (job.currentStep >= 0 && job.steps[job.currentStep]) {
    job.steps[job.currentStep].status = "done";
    delete job.steps[job.currentStep].progress;
  }
  job.currentStep++;
  if (job.steps[job.currentStep]) {
    job.steps[job.currentStep].status = "active";
    if (detail) job.steps[job.currentStep].detail = detail;
  }
  job.updatedAt = Date.now();
}

export function updateProgress(
  id: string,
  current: number,
  total: number,
  detail?: string,
) {
  const job = jobs.get(id);
  if (!job || job.currentStep < 0) return;
  const step = job.steps[job.currentStep];
  if (step) {
    step.progress = { current, total };
    if (detail !== undefined) step.detail = detail;
  }
  job.updatedAt = Date.now();
}

export function completeJob(id: string, result: Record<string, unknown>) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.currentStep >= 0 && job.steps[job.currentStep]) {
    job.steps[job.currentStep].status = "done";
  }
  job.status = "completed";
  job.result = result;
  job.updatedAt = Date.now();
}

export function failJob(id: string, error: string) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.currentStep >= 0 && job.steps[job.currentStep]) {
    job.steps[job.currentStep].status = "error";
    job.steps[job.currentStep].detail = error;
  }
  job.status = "failed";
  job.error = error;
  job.updatedAt = Date.now();
}

// ── Cancellation support ──────────────────────────────────────────

const cancelled = new Set<string>();

/** Mark a running job for cancellation. */
export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== "running") return false;
  cancelled.add(id);
  return true;
}

/** Check if a job has been cancelled. Call this in hot loops. */
export function isCancelled(id: string): boolean {
  return cancelled.has(id);
}

/** Mark the job as failed-due-to-cancellation and clean up the flag. */
export function applyCancellation(id: string) {
  cancelled.delete(id);
  failJob(id, "Cancelled by user");
}
