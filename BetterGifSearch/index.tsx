/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { definePluginSettings } from "@api/Settings";
import { Divider } from "@components/Divider";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { Devs } from "@utils/constants";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Button, React, Slider, Text, TextInput, useCallback, useEffect, useRef, UserStore, useState } from "@webpack/common";

const UserSettingsProtoStore = findByPropsLazy("frecencyWithoutFetchingLatest");

interface Gif {
    format: number;
    src: string;
    width: number;
    height: number;
    order: number;
    url: string;
}

interface Instance {
    dead?: boolean;
    state: {
        resultType?: string;
    };
    props: {
        favCopy?: Gif[];
        favorites: Gif[];
    };
    forceUpdate: () => void;
}

let activeInstance: Instance | null = null;
const failedLinks = new Set<string>();

function getSavedFavorites(): Gif[] {
    try {
        const raw = UserSettingsProtoStore?.frecencyWithoutFetchingLatest?.favoriteGifs?.gifs;
        if (raw) {
            return Object.entries(raw).map(([url, gif]: [string, Partial<Gif>]) => ({
                format: gif.format ?? 1,
                src: gif.src ?? "",
                width: gif.width ?? 0,
                height: gif.height ?? 0,
                order: gif.order ?? 0,
                url: gif.url ?? url
            }));
        }
    } catch { }
    return [];
}

function getFavoritesList(): Gif[] {
    if (activeInstance?.props?.favCopy) {
        return activeInstance.props.favCopy;
    }
    return getSavedFavorites();
}

// Track indexing state
let lastUserId: string | null = null;
let lastIndexedFavorites: string[] = [];
let pendingIndexRequest = false;

function getModelWeights(): Record<string, number> {
    return settings.store.modelWeights ?? {};
}

function stripUrlParams(urlStr: string): string {
    if (!urlStr) return "";
    try {
        const url = new URL(urlStr);
        return `${url.origin}${url.pathname}`;
    } catch {
        return urlStr;
    }
}

function generateUuid(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

function ensureUuid(): string {
    let uuid = settings.store.uuid;
    if (!uuid) {
        uuid = generateUuid();
        settings.store.uuid = uuid;
    }
    return uuid;
}

// Fetch currently indexed links from the server
async function fetchIndexedLinks(): Promise<Set<string>> {
    const uuid = ensureUuid();

    try {
        const response = await fetch(`${settings.store.api_url}/${uuid}/links`);
        if (!response.ok) return new Set();
        const res = (await response.json()) as { type: string; data: Record<string, string>; };
        if (res.type === "success" && res.data) {
            return new Set(Object.values(res.data).map(stripUrlParams));
        }
    } catch { }
    return new Set();
}

// Get valid gifs applying domain filters
function getValidGifs(favorites: Gif[]): Gif[] {
    const validGifs: Gif[] = [];

    for (const gif of favorites) {
        if (!gif.src) continue;

        try {
            const url = new URL(gif.src);
            const domain = url.host;

            const isDiscordDomain = domain.endsWith(".discordapp.net") || domain.endsWith(".discordapp.com");
            const isTenorDomain = domain.endsWith(".tenor.com") || domain.endsWith(".tenor.co") || domain === "tenor.com";
            if (!domain || domain.length > 256 || (!isDiscordDomain && !isTenorDomain)) {
                continue;
            }

            validGifs.push(gif);
        } catch {
            continue;
        }
    }

    return validGifs;
}

// Function to send index request
async function indexFavorites(favorites: Gif[]) {
    const uuid = ensureUuid();

    if (pendingIndexRequest) {
        return;
    }

    const user = UserStore.getCurrentUser();
    const id = user ? user.id : null;
    const validGifs = getValidGifs(favorites);

    if (validGifs.length === 0) {
        lastIndexedFavorites = [];
        lastUserId = id;
        return;
    }

    pendingIndexRequest = true;

    try {
        const indexedLinks = await fetchIndexedLinks();

        // Find gifs that aren't indexed on server yet
        const toIndex = validGifs.filter(gif => !indexedLinks.has(stripUrlParams(gif.src)));

        for (let i = 0; i < toIndex.length; i++) {
            const gif = toIndex[i];
            try {
                const response = await fetch(`${settings.store.api_url}/${uuid}/index`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({ link: gif.src })
                });

                if (response.status === 429) {
                    let waitTime = 1000;
                    const retryHeader = response.headers.get("retry-after");
                    if (retryHeader) {
                        const parsed = parseFloat(retryHeader);
                        if (!isNaN(parsed)) {
                            waitTime = parsed * 1000;
                        }
                    }
                    await sleep(waitTime);
                    i--; // retry current index
                    continue;
                }

                if (response.ok) {
                    const res = (await response.json()) as { type: string; };
                    if (res.type === "success") {
                        indexedLinks.add(stripUrlParams(gif.src));
                        failedLinks.delete(gif.src);
                    } else {
                        failedLinks.add(gif.src);
                    }
                } else {
                    failedLinks.add(gif.src);
                }
            } catch {
                failedLinks.add(gif.src);
            }
        }

        lastIndexedFavorites = validGifs.map(g => stripUrlParams(g.src));
        lastUserId = id;
    } catch { } finally {
        pendingIndexRequest = false;
    }
}

// Function to check if indexing is needed
function shouldIndex(favorites: Gif[]): boolean {
    const user = UserStore.getCurrentUser();
    const id = user ? user.id : null;
    if (lastUserId !== id) return true;

    const currentValidGifs = getValidGifs(favorites);

    if (currentValidGifs.length !== lastIndexedFavorites.length) {
        return true;
    }

    for (let i = 0; i < currentValidGifs.length; i++) {
        if (stripUrlParams(currentValidGifs[i].src) !== lastIndexedFavorites[i]) {
            return true;
        }
    }

    return false;
}

// Model weights settings component
function ModelWeightsComponent() {
    const [models, setModels] = useState<Record<string, number>>(() => getModelWeights());

    useEffect(() => {
        if (Object.keys(models).length === 0) {
            (async () => {
                try {
                    const response = await fetch(`${settings.store.api_url}/providers`);
                    if (!response.ok) return;
                    const res = (await response.json()) as { type: string; data: string[]; };
                    if (res.type !== "success" || !res.data) return;

                    const remote: Record<string, number> = {};
                    for (const name of res.data) {
                        remote[name] = 1.0;
                    }
                    const combined = { ...remote, ...getModelWeights() };
                    setModels(combined);
                    settings.store.modelWeights = combined;
                } catch { }
            })();
        }
    }, [models]);

    function setModelWeight(name: string, weight: number) {
        const next = { ...models, [name]: weight };
        setModels(next);
        settings.store.modelWeights = next;
    }

    return (
        <section>
            <Heading tag="h3">CLIP Models</Heading>
            <Paragraph>
                Adjust how model outputs are weighted when searching favorite GIFs.
            </Paragraph>

            <div style={{ marginTop: 8 }}>
                {Object.entries(models).map(([name, weight]) => (
                    <div key={name} style={{ marginBottom: 12 }}>
                        <Heading tag="h4">{name}</Heading>
                        <Flex flexDirection="row" style={{ alignItems: "center", gap: "0.75rem", marginTop: 6 }}>
                            <div style={{ flex: 1 }}>
                                <Slider
                                    markers={[0, 1]}
                                    minValue={0}
                                    maxValue={1}
                                    initialValue={weight}
                                    onValueChange={(v: number) => setModelWeight(name, v)}
                                    onValueRender={(v: number) => `${(v * 100).toFixed(0)}%`}
                                    stickToMarkers={false}
                                />
                            </div>
                            <Text variant="text-xs/normal" style={{ width: 54, textAlign: "right", color: "var(--text-muted)" }}>
                                {(weight * 100).toFixed(0)}%
                            </Text>
                        </Flex>
                    </div>
                ))}
            </div>

            <Divider style={{ marginTop: 12 }} />
        </section>
    );
}

function IndexingStatsComponent() {
    const [indexedCount, setIndexedCount] = useState<number | null>(null);
    const [totalValid, setTotalValid] = useState<number>(0);
    const [totalFavs, setTotalFavs] = useState<number>(0);
    const [failedCount, setFailedCount] = useState<number>(0);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;
        (async () => {
            try {
                const favs = getFavoritesList();
                const valid = getValidGifs(favs);
                if (!isMounted) return;
                setTotalFavs(favs.length);
                setTotalValid(valid.length);
                setFailedCount(failedLinks.size);

                const uuid = ensureUuid();
                const response = await fetch(`${settings.store.api_url}/${uuid}/links`);
                if (!response.ok) {
                    if (isMounted) setLoading(false);
                    return;
                }
                const res = (await response.json()) as { type: string; data: Record<string, string>; };
                if (!isMounted) return;
                if (res.type === "success" && res.data) {
                    const serverSet = new Set(Object.values(res.data).map(stripUrlParams));
                    const matchCount = valid.filter(gif => serverSet.has(stripUrlParams(gif.src))).length;
                    setIndexedCount(matchCount);
                }
            } catch { } finally {
                if (isMounted) setLoading(false);
            }
        })();
        return () => {
            isMounted = false;
        };
    }, []);

    const pendingCount = indexedCount !== null ? Math.max(0, totalValid - indexedCount) : 0;

    return (
        <section>
            <Heading tag="h3">Indexing Database Statistics</Heading>
            <Paragraph>
                Status counts of your local favorite GIFs and the indexing backend.
            </Paragraph>

            <div style={{ marginTop: 12 }}>
                {loading ? (
                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)" }}>
                        Loading stats...
                    </Text>
                ) : (
                    <Flex flexDirection="row" style={{ gap: "1rem", flexWrap: "wrap", marginTop: 8 }}>
                        <div style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            minWidth: 80,
                            padding: 12,
                            backgroundColor: "var(--background-secondary)",
                            borderRadius: 8
                        }}>
                            <Text variant="text-lg/semibold" style={{ color: "var(--text-normal)" }}>{totalFavs}</Text>
                            <Text variant="text-xs/normal" style={{ color: "var(--text-muted)", marginTop: 4 }}>Total Favorites</Text>
                        </div>
                        <div style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            minWidth: 80,
                            padding: 12,
                            backgroundColor: "var(--background-secondary)",
                            borderRadius: 8
                        }}>
                            <Text variant="text-lg/semibold" style={{ color: "var(--status-positive)" }}>{indexedCount ?? 0}</Text>
                            <Text variant="text-xs/normal" style={{ color: "var(--text-muted)", marginTop: 4 }}>Indexed</Text>
                        </div>
                        <div style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            minWidth: 80,
                            padding: 12,
                            backgroundColor: "var(--background-secondary)",
                            borderRadius: 8
                        }}>
                            <Text variant="text-lg/semibold" style={{ color: "var(--status-warning)" }}>{pendingCount}</Text>
                            <Text variant="text-xs/normal" style={{ color: "var(--text-muted)", marginTop: 4 }}>Pending</Text>
                        </div>
                        <div style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            minWidth: 80,
                            padding: 12,
                            backgroundColor: "var(--background-secondary)",
                            borderRadius: 8
                        }}>
                            <Text variant="text-lg/semibold" style={{ color: "var(--status-danger)" }}>{failedCount}</Text>
                            <Text variant="text-xs/normal" style={{ color: "var(--text-muted)", marginTop: 4 }}>Failed</Text>
                        </div>
                    </Flex>
                )}
            </div>
            <Divider style={{ marginTop: 12 }} />
        </section>
    );
}

function UuidManagerComponent() {
    const [uuid, setUuid] = useState(() => settings.store.uuid || "");

    const updateUuid = useCallback((val: string) => {
        val = val.trim();
        settings.store.uuid = val;
        setUuid(val);
    }, []);

    const generateNew = useCallback(() => {
        const next = generateUuid();
        updateUuid(next);
    }, [updateUuid]);

    const copyToClipboard = useCallback(() => {
        navigator.clipboard.writeText(uuid);
    }, [uuid]);

    return (
        <section>
            <Heading tag="h3">Database Sync UUID</Heading>
            <Paragraph>
                This UUID serves as your unique database key that identifies your indexed GIF embeddings on the backend. Share this UUID across your devices to keep them in sync.
            </Paragraph>

            <div style={{ marginTop: 12 }}>
                <Flex flexDirection="row" style={{ gap: "0.5rem", alignItems: "stretch" }}>
                    <div style={{ flex: 1 }}>
                        <TextInput
                            value={uuid}
                            onChange={(val: string) => updateUuid(val)}
                            placeholder="Enter or generate UUID"
                        />
                    </div>
                    <Button
                        onClick={copyToClipboard}
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.PRIMARY}
                        style={{ minHeight: "32px" }}
                    >
                        Copy
                    </Button>
                    <Button
                        onClick={generateNew}
                        size={Button.Sizes.SMALL}
                        color={Button.Colors.PRIMARY}
                        style={{ minHeight: "32px" }}
                    >
                        Generate New
                    </Button>
                </Flex>
            </div>

            <Divider style={{ marginTop: 12 }} />
        </section>
    );
}

export const settings = definePluginSettings({
    api_url: {
        type: OptionType.STRING,
        description: "API URL",
        default: "http://localhost:6335"
    },
    uuid: {
        type: OptionType.STRING,
        description: "Integration UUID (identifies your database of GIF embeddings)",
        default: "",
        hidden: true
    },
    clip_weights_component: {
        type: OptionType.COMPONENT,
        component: ModelWeightsComponent
    },
    uuid_manager_component: {
        type: OptionType.COMPONENT,
        component: UuidManagerComponent
    },
    stats_component: {
        type: OptionType.COMPONENT,
        component: IndexingStatsComponent
    },
}).withPrivateSettings<{ modelWeights?: Record<string, number>; }>();

export default definePlugin({
    name: "BetterGifSearch",
    authors: [Devs.Aria, { name: "Woodie", id: 851073836152651777n }, { name: "V", id: 315547631373778945n }],
    description: "Adds an AI-powered search bar to favorite gifs.",

    start() {
        ensureUuid();

        // Try to fetch available models/providers from the API and initialize weights if missing
        (async () => {
            try {
                const response = await fetch(`${settings.store.api_url}/providers`);
                if (!response.ok) return;
                const res = (await response.json()) as { type: string; data: string[]; };
                if (res.type !== "success" || !res.data) return;

                const current = getModelWeights();
                let changed = false;
                for (const name of res.data) {
                    if (current[name] === undefined) {
                        current[name] = 1.0;
                        changed = true;
                    }
                }
                if (changed) {
                    settings.store.modelWeights = current;
                }
            } catch { }
        })();
    },

    patches: [
        {
            find: "renderHeaderContent(){",
            replacement: [
                {
                    match: /(case\s+(?:\i\.)+FAVORITES:\s*return)(?:[\s\S]*?)(?=case)/,
                    replace: "$1 $self.renderSearchBar(this);"
                },
                {
                    match: /(,suggestions:\i,favorites:)(\i),/,
                    replace: "$1$self.getFav($2),favCopy:$2,"
                }
            ]
        }
    ],

    settings,

    instance: null as Instance | null,
    renderSearchBar(instance: Instance) {
        activeInstance = instance;
        this.instance = instance;
        return (
            <ErrorBoundary noop>
                <SearchBar instance={instance} />
            </ErrorBoundary>
        );
    },

    getFav(favorites: Gif[]) {
        if (!this.instance || this.instance.dead) return favorites;
        const filteredFavorites = this.instance.props?.favorites;

        const favoritesToReturn = filteredFavorites != null && filteredFavorites.length !== favorites.length ? filteredFavorites : favorites;

        if (shouldIndex(favorites)) {
            indexFavorites(favorites);
        }

        return favoritesToReturn;
    }
});

function SearchBar({ instance }: { instance: Instance; }) {
    const [query, setQuery] = useState("");
    const [debouncedQuery, setDebouncedQuery] = useState("");
    const ref = useRef<HTMLInputElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Check for ranking weight changes and trigger indexing if needed
    useEffect(() => {
        const favs = instance.props.favCopy ?? instance.props.favorites;
        if (favs && shouldIndex(favs)) {
            indexFavorites(favs);
        }
    });

    const clearSearch = useCallback(() => {
        if (debounceTimeoutRef.current) {
            clearTimeout(debounceTimeoutRef.current);
        }
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
        setQuery("");
        setDebouncedQuery("");
        if (instance.props.favCopy != null) {
            instance.props.favorites = instance.props.favCopy;
            instance.forceUpdate();
        }
    }, [instance]);

    const onChange = useCallback((searchQuery: string) => {
        setQuery(searchQuery);

        if (debounceTimeoutRef.current) {
            clearTimeout(debounceTimeoutRef.current);
        }
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        if (searchQuery === "") {
            setDebouncedQuery("");
            if (instance.props.favCopy != null) {
                instance.props.favorites = instance.props.favCopy;
                instance.forceUpdate();
            }
            return;
        }

        debounceTimeoutRef.current = setTimeout(() => {
            setDebouncedQuery(searchQuery);
        }, 300);
    }, [instance]);

    useEffect(() => {
        if (debouncedQuery === "") return;

        const performSearch = async () => {
            const uuid = ensureUuid();
            const { props } = instance;
            const favCopy = props.favCopy ?? props.favorites;
            if (!favCopy) return;

            abortControllerRef.current = new AbortController();

            // Scroll back to top
            ref.current
                ?.closest("#gif-picker-tab-panel")
                ?.querySelector("[class|=\"content\"]")
                ?.firstElementChild?.scrollTo(0, 0);

            try {
                const response = await fetch(`${settings.store.api_url}/${uuid}/search?query=${encodeURIComponent(debouncedQuery)}`, {
                    signal: abortControllerRef.current.signal
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const data = (await response.json()) as {
                    type: string;
                    data: {
                        providers: Record<string, { link: string; score: number; }[]>;
                    };
                };

                if (data.type !== "success" || !data.data || !data.data.providers) {
                    throw new Error("Invalid search API response");
                }

                const modelResults = data.data.providers;
                const modelWeights = getModelWeights();

                const rankingMaps: Record<string, Map<string, number>> = {};
                Object.entries(modelResults).forEach(([modelId, results]) => {
                    const sorted = [...results].sort((a, b) => b.score - a.score);
                    const map = new Map<string, number>();
                    sorted.forEach((item, idx) => {
                        map.set(item.link, idx + 1);
                    });
                    rankingMaps[modelId] = map;
                });

                const weights: Record<string, number> = {};
                for (const modelId of Object.keys(modelResults)) {
                    if (modelWeights[modelId] !== undefined) {
                        weights[modelId] = modelWeights[modelId];
                    } else {
                        const found = Object.keys(modelWeights).find(k => k.toLowerCase() === modelId.toLowerCase());
                        if (found) weights[modelId] = modelWeights[found];
                        else weights[modelId] = 1.0;
                    }
                }

                const allUrls = new Set<string>();
                Object.values(modelResults).forEach(results => {
                    results.forEach(item => allUrls.add(item.link));
                });

                const aggregated = Array.from(allUrls).map(url => {
                    let totalScore = 0;
                    let totalWeight = 0;

                    for (const [modelId, rankMap] of Object.entries(rankingMaps)) {
                        const weight = weights[modelId] ?? 1.0;
                        const rank = rankMap.get(url);
                        if (rank !== undefined) {
                            const score = 1 / rank;
                            totalScore += score * weight;
                            totalWeight += weight;
                        }
                    }

                    if (totalWeight === 0) return null;

                    const gif = favCopy.find(g => stripUrlParams(g.src) === stripUrlParams(url) || stripUrlParams(g.url) === stripUrlParams(url));
                    return gif ? { combinedScore: totalScore / totalWeight, gif } : null;
                }).filter(Boolean) as { combinedScore: number; gif: Gif; }[];

                aggregated.sort((a, b) => b.combinedScore - a.combinedScore);
                props.favorites = aggregated.map(e => e.gif);
                instance.forceUpdate();
            } catch (err: unknown) {
                if (err instanceof Error && err.name === "AbortError") {
                    return;
                }
                console.error("[BetterGifSearch] Error fetching search results:", err);
                instance.forceUpdate();
            }
        };

        performSearch();
    }, [debouncedQuery, instance]);

    useEffect(() => {
        return () => {
            if (debounceTimeoutRef.current) {
                clearTimeout(debounceTimeoutRef.current);
            }
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            instance.dead = true;
        };
    }, []);

    return (
        <TextInput
            autoFocus
            value={query}
            onChange={onChange}
            placeholder="Search Favorite GIFs"
            ref={ref}
            onKeyDown={event => {
                if (event.key === "Escape") {
                    event.stopPropagation();
                    event.preventDefault();
                    clearSearch();
                }
            }}
        />
    );
}
