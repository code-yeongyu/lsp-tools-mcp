import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import {
	awaitSharedAbortableOperation,
	createSharedAbortableOperation,
	type SharedAbortableOperation,
} from "./abortable-shared-operation.js";
import {
	type ManifestSnapshot,
	readAncestorManifestSnapshots,
	readManifestSnapshot,
	snapshotsAreFresh,
} from "./cargo-manifest-snapshot.js";
import { canonicalManifest, parseTrustedCargoMetadata, type TrustedCargoMetadata } from "./cargo-metadata-parser.js";
import { type CargoMetadataLoader, defaultCargoMetadataLoader } from "./cargo-metadata-process.js";

const CARGO_METADATA_FAILURE_BACKOFF_MS = 1_000;

export type { CargoMetadataLoader } from "./cargo-metadata-process.js";

export type Clock = () => number;

export interface CargoWorkspaceRootOptions {
	readonly cargoMetadataLoader?: CargoMetadataLoader;
	readonly now?: Clock;
	readonly signal?: AbortSignal;
}

interface CargoWorkspaceCacheEntry {
	readonly root: string;
	readonly snapshots: readonly ManifestSnapshot[];
}

interface CargoWorkspaceFailureCacheEntry {
	readonly expiresAtMs: number;
	readonly snapshots: readonly ManifestSnapshot[];
}

interface CargoWorkspaceRootRequest {
	readonly manifestDir: string;
	readonly loader: CargoMetadataLoader;
	readonly now: Clock;
	readonly signal: AbortSignal | undefined;
}

interface CargoWorkspaceLoadRequest extends CargoWorkspaceRootRequest {
	readonly nowMs: number;
	readonly snapshots: readonly ManifestSnapshot[];
}

interface PreparedCargoWorkspaceCache {
	readonly root: string;
	readonly entries: ReadonlyMap<string, CargoWorkspaceCacheEntry>;
}

const cargoWorkspaceRootCache = new Map<string, CargoWorkspaceCacheEntry>();
const cargoWorkspaceRootFailures = new Map<string, CargoWorkspaceFailureCacheEntry>();
const cargoWorkspaceRootInFlight = new Map<string, SharedAbortableOperation<string | undefined>>();

function realpathSafe(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

function nearestCargoManifestDir(startDir: string): string | undefined {
	let dir = startDir;
	let prev = "";
	while (dir !== prev) {
		if (existsSync(join(dir, "Cargo.toml"))) return dir;
		prev = dir;
		dir = dirname(dir);
	}
	return undefined;
}

function cacheEntryFor(
	root: string,
	rootManifestPath: string,
	memberManifestPath: string,
): CargoWorkspaceCacheEntry | undefined {
	const uniqueManifestPaths = [...new Set([memberManifestPath, rootManifestPath])];
	const snapshots: ManifestSnapshot[] = [];
	for (const manifestPath of uniqueManifestPaths) {
		const snapshot = readManifestSnapshot(manifestPath);
		if (snapshot === undefined) return undefined;
		snapshots.push(snapshot);
	}
	return { root, snapshots };
}

function prepareCargoWorkspaceCache(
	manifestDir: string,
	metadata: TrustedCargoMetadata,
): PreparedCargoWorkspaceCache | undefined {
	const entries = new Map<string, CargoWorkspaceCacheEntry>();
	for (const manifestPath of metadata.memberManifestPaths) {
		const entry = cacheEntryFor(metadata.workspaceRoot, metadata.rootManifestPath, manifestPath);
		if (entry === undefined) return undefined;
		entries.set(dirname(manifestPath), entry);
	}

	const requestedManifestPath = canonicalManifest(join(manifestDir, "Cargo.toml"));
	if (requestedManifestPath === undefined) return undefined;
	const requestedEntry = cacheEntryFor(metadata.workspaceRoot, metadata.rootManifestPath, requestedManifestPath);
	if (requestedEntry === undefined) return undefined;
	entries.set(manifestDir, requestedEntry);
	return { root: metadata.workspaceRoot, entries };
}

function preparedCacheIsFresh(prepared: PreparedCargoWorkspaceCache): boolean {
	for (const entry of prepared.entries.values()) {
		if (!snapshotsAreFresh(entry.snapshots)) return false;
	}
	return true;
}

function commitCargoWorkspaceCache(prepared: PreparedCargoWorkspaceCache): void {
	for (const [manifestDir, entry] of prepared.entries) {
		cargoWorkspaceRootCache.set(manifestDir, entry);
	}
}

function cacheCargoWorkspaceFailure(manifestDir: string, nowMs: number, snapshots: readonly ManifestSnapshot[]): void {
	cargoWorkspaceRootFailures.set(manifestDir, {
		expiresAtMs: nowMs + CARGO_METADATA_FAILURE_BACKOFF_MS,
		snapshots,
	});
}

function cachedCargoWorkspaceFailure(manifestDir: string, nowMs: number): boolean {
	const cached = cargoWorkspaceRootFailures.get(manifestDir);
	if (cached === undefined) return false;
	if (nowMs >= cached.expiresAtMs) {
		cargoWorkspaceRootFailures.delete(manifestDir);
		return false;
	}
	if (snapshotsAreFresh(cached.snapshots)) return true;
	cargoWorkspaceRootFailures.delete(manifestDir);
	return false;
}

function isAbortError(error: unknown): boolean {
	if (error instanceof DOMException && error.name === "AbortError") return true;
	return error instanceof Error && error.name === "AbortError";
}

function deleteInFlight(manifestDir: string, inFlight: SharedAbortableOperation<string | undefined>): void {
	if (cargoWorkspaceRootInFlight.get(manifestDir) === inFlight) {
		cargoWorkspaceRootInFlight.delete(manifestDir);
	}
}

function createInFlightCargoWorkspaceRoot(
	request: CargoWorkspaceLoadRequest,
): SharedAbortableOperation<string | undefined> {
	let inFlight: SharedAbortableOperation<string | undefined>;
	inFlight = createSharedAbortableOperation(
		(signal) => loadCargoWorkspaceRoot({ ...request, signal }),
		() => {
			deleteInFlight(request.manifestDir, inFlight);
		},
		() => {
			deleteInFlight(request.manifestDir, inFlight);
		},
	);
	return inFlight;
}

async function loadCargoWorkspaceRoot(request: CargoWorkspaceLoadRequest): Promise<string | undefined> {
	try {
		request.signal?.throwIfAborted();
		const manifestPath = join(request.manifestDir, "Cargo.toml");
		const output = await request.loader(manifestPath, request.signal);
		request.signal?.throwIfAborted();
		if (!snapshotsAreFresh(request.snapshots)) {
			cacheCargoWorkspaceFailure(request.manifestDir, request.nowMs, request.snapshots);
			return undefined;
		}

		const metadata = parseTrustedCargoMetadata(manifestPath, output);
		if (metadata === undefined || !snapshotsAreFresh(request.snapshots)) {
			cacheCargoWorkspaceFailure(request.manifestDir, request.nowMs, request.snapshots);
			return undefined;
		}

		const prepared = prepareCargoWorkspaceCache(request.manifestDir, metadata);
		if (prepared === undefined || !snapshotsAreFresh(request.snapshots) || !preparedCacheIsFresh(prepared)) {
			cacheCargoWorkspaceFailure(request.manifestDir, request.nowMs, request.snapshots);
			return undefined;
		}

		commitCargoWorkspaceCache(prepared);
		cargoWorkspaceRootFailures.delete(request.manifestDir);
		return prepared.root;
	} catch (error) {
		if (request.signal?.aborted || isAbortError(error)) throw error;
		cacheCargoWorkspaceFailure(request.manifestDir, request.nowMs, request.snapshots);
		return undefined;
	}
}

function cachedCargoWorkspaceRoot(manifestDir: string): string | undefined {
	const cached = cargoWorkspaceRootCache.get(manifestDir);
	if (cached === undefined) return undefined;
	if (snapshotsAreFresh(cached.snapshots)) return cached.root;
	cargoWorkspaceRootCache.delete(manifestDir);
	return undefined;
}

async function cargoWorkspaceRoot(request: CargoWorkspaceRootRequest): Promise<string | undefined> {
	request.signal?.throwIfAborted();
	const cached = cachedCargoWorkspaceRoot(request.manifestDir);
	if (cached !== undefined) return cached;

	const nowMs = request.now();
	if (cachedCargoWorkspaceFailure(request.manifestDir, nowMs)) return undefined;

	const inFlight = cargoWorkspaceRootInFlight.get(request.manifestDir);
	if (inFlight !== undefined) return awaitSharedAbortableOperation(inFlight, request.signal);

	const snapshots = readAncestorManifestSnapshots(request.manifestDir);
	if (snapshots === undefined) return undefined;

	const newInFlight = createInFlightCargoWorkspaceRoot({ ...request, nowMs, snapshots });
	cargoWorkspaceRootInFlight.set(request.manifestDir, newInFlight);
	return awaitSharedAbortableOperation(newInFlight, request.signal);
}

export async function resolveCargoWorkspaceRoot(
	startDir: string,
	options: CargoWorkspaceRootOptions = {},
): Promise<string | undefined> {
	const manifestDir = nearestCargoManifestDir(realpathSafe(startDir));
	if (manifestDir === undefined) return undefined;
	const canonicalManifestDir = realpathSafe(manifestDir);
	const root = await cargoWorkspaceRoot({
		manifestDir: canonicalManifestDir,
		loader: options.cargoMetadataLoader ?? defaultCargoMetadataLoader,
		now: options.now ?? Date.now,
		signal: options.signal,
	});
	return root ?? canonicalManifestDir;
}
