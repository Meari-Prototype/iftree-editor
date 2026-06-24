interface BalancedWorkerCountOptions {
  logicalCores?: number;
  jobCount?: number;
  foreground?: boolean;
}

export function balancedWorkerCount({
  logicalCores = 1,
  jobCount = Infinity,
  foreground = false
}: BalancedWorkerCountOptions = {}): number {
  const cores = Math.max(1, Math.floor(Number(logicalCores) || 1));
  const jobs = Math.max(1, Math.floor(Number(jobCount) || 1));
  let workers: number;

  if (foreground) workers = cores <= 4 ? 1 : Math.max(2, Math.floor(cores / 2));
  else if (cores <= 2) workers = 1;
  else if (cores <= 4) workers = cores - 1;
  else workers = Math.min(cores - 1, 4);

  return Math.max(1, Math.min(jobs, workers));
}

export function browserLogicalCores(): number {
  return Math.max(1, Math.floor(Number((globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency) || 1));
}

export function canvas2dContextOptions(): { alpha: boolean; desynchronized: boolean; willReadFrequently: boolean } {
  return {
    alpha: true,
    desynchronized: true,
    willReadFrequently: false
  };
}