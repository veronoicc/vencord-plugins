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
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { Devs } from "@utils/constants";
import { sleep } from "@utils/misc";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { Button, Forms, React, Slider, Text, TextInput, useCallback, useEffect, useRef, UserStore, useState } from "@webpack/common";

const favoriteGifsStore = findByPropsLazy("bW", "getCurrentValue");

interface SearchBarComponentProps {
    ref?: React.RefObject<any>;
    autoFocus: boolean;
    size: string;
    onChange: (query: string) => void;
    onClear: () => void;
    query: string;
    placeholder: string;
    className?: string;
}

type TSearchBarComponent = React.FC<SearchBarComponentProps>;

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
        favCopy: Gif[];
        favorites: Gif[];
    };
    forceUpdate: () => void;
}

let activeInstance: Instance | null = null;
const failedLinks = new Set<string>();

function getSavedFavorites(): Gif[] {
    try {
        const store = favoriteGifsStore?.bW;
        if (store && typeof store.getCurrentValue === "function") {
            const gifs = store.getCurrentValue()?.favoriteGifs?.gifs ?? {};
            return Object.values(gifs) as Gif[];
        }
    } catch { }
    return [];
}

function getFavoritesList(): Gif[] {
    if (activeInstance && activeInstance.props.favCopy) {
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
    try {
        const url = new URL(urlStr);
        return `${url.origin}${url.pathname}`;
    } catch {
        return urlStr;
    }
}

// Fetch currently indexed links from the server
async function fetchIndexedLinks(): Promise<Set<string>> {
    const uuid = settings.store.uuid;
    if (!uuid) return new Set();

    try {
        const response = await fetch(`${settings.store.api_url}/${uuid}/links`);
        if (!response.ok) return new Set();
        const res = (await response.json()) as { type: string; data: Record<string, string>; };
        if (res.type === "success" && res.data) {
            return new Set(Object.values(res.data).map(stripUrlParams));
        }
    } catch (e) {
        // Safe logging or ignore
    }
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

            // Check domain validity
            const isDiscordDomain = domain.endsWith(".discordapp.net") || domain.endsWith(".discordapp.com");
            const isTenorDomain = domain === "media.tenor.co" || domain === "c.tenor.com";
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
    const uuid = settings.store.uuid;
    if (!uuid) return;

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
            } catch (e) {
                failedLinks.add(gif.src);
            }
        }

        lastIndexedFavorites = validGifs.map(g => stripUrlParams(g.src));
        lastUserId = id;
    } catch (error) {
        // ignore
    } finally {
        pendingIndexRequest = false;
    }
}

// Function to check if indexing is needed
function shouldIndex(favorites: Gif[]): boolean {
    const user = UserStore.getCurrentUser();
    const id = user ? user.id : null;
    if (lastUserId !== id) return true;

    const currentValidGifs = getValidGifs(favorites);

    // Check if valid favorites changed
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
        // if we don't have models in settings, try fetching from API
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
                    (settings.store as any).modelWeights = combined;
                } catch (e) {
                    // ignore
                }
            })();
        }
    }, [models]);

    function setModelWeight(name: string, weight: number) {
        const next = { ...models, [name]: weight };
        setModels(next);
        (settings.store as any).modelWeights = next;
    }

    return (
        <Forms.FormSection>
            <Forms.FormTitle tag="h3">Models</Forms.FormTitle>
            <Forms.FormText>
                Adjust how model outputs are weighted when searching favorite GIFs.
            </Forms.FormText>

            <div style={{ marginTop: 8 }}>
                {Object.entries(models).map(([name, weight]) => (
                    <div key={name} style={{ marginBottom: 12 }}>
                        <Forms.FormTitle tag="h4">{name}</Forms.FormTitle>
                        <Flex flexDirection={Flex.Direction.HORIZONTAL} style={{ alignItems: "center", gap: "0.75rem", marginTop: 6 }}>
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
                            <Text variant={"text-xs/normal"} style={{ width: 54, textAlign: "right", color: "var(--text-muted)" }}>
                                {(weight * 100).toFixed(0)}%
                            </Text>
                        </Flex>
                    </div>
                ))}
            </div>

            <Forms.FormDivider style={{ marginTop: 6 }} />
        </Forms.FormSection>
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

                const uuid = settings.store.uuid;
                if (!uuid) {
                    setLoading(false);
                    return;
                }
                const response = await fetch(`${settings.store.api_url}/${uuid}/links`);
                if (!response.ok) {
                    setLoading(false);
                    return;
                }
                const res = await response.json() as { type: string; data: Record<string, string>; };
                if (!isMounted) return;
                if (res.type === "success" && res.data) {
                    const serverSet = new Set(Object.values(res.data).map(stripUrlParams));
                    const matchCount = valid.filter(gif => serverSet.has(stripUrlParams(gif.src))).length;
                    setIndexedCount(matchCount);
                }
            } catch (e) {
                // ignore
            } finally {
                if (isMounted) setLoading(false);
            }
        })();
        return () => {
            isMounted = false;
        };
    }, []);

    const pendingCount = indexedCount !== null ? Math.max(0, totalValid - indexedCount) : 0;

    return (
        <Forms.FormSection>
            <Forms.FormTitle tag="h3">Indexing Database Statistics</Forms.FormTitle>
            <Forms.FormText>
                Status counts of your local favorite GIFs and the indexing backend.
            </Forms.FormText>

            <div style={{ marginTop: 12 }}>
                {loading ? (
                    <Text variant="text-sm/normal" style={{ color: "var(--text-muted)" }}>
                        Loading stats...
                    </Text>
                ) : (
                    <Flex flexDirection={Flex.Direction.HORIZONTAL} style={{ gap: "1rem", flexWrap: "wrap", marginTop: 8 }}>
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
            <Forms.FormDivider style={{ marginTop: 12 }} />
        </Forms.FormSection>
    );
}

function generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
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
        <Forms.FormSection>
            <Forms.FormTitle tag="h3">Database Sync UUID</Forms.FormTitle>
            <Forms.FormText>
                This UUID serves as your unique database key that identifies your indexed GIF embeddings on the backend. Share this UUID across your devices to keep them in sync.
            </Forms.FormText>

            <div style={{ marginTop: 12 }}>
                <Flex flexDirection={Flex.Direction.HORIZONTAL} style={{ gap: "0.5rem", alignItems: "stretch" }}>
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

            <Forms.FormDivider style={{ marginTop: 12 }} />
        </Forms.FormSection>
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
    authors: [Devs.Aria, { name: "Woodie", id: 851073836152651777n}, { name: "V", id: 315547631373778945n }],
    description: "Adds an AI-powered search bar to favorite gifs.",

    start() {
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
                    (settings.store as any).modelWeights = current;
                }
            } catch (e) {
                // ignore
            }
        })();
    },

    patches: [
        {
            find: "renderHeaderContent()",
            replacement: [
                {
                    // https://regex101.com/r/07gpzP/1
                    // ($1 renderHeaderContent=function { ... switch (x) ... case FAVORITES:return) ($2) ($3 case default: ... return r.jsx(($<searchComp>), {...props}))
                    match: /(renderHeaderContent\(\).{1,150}FAVORITES:return)(.{1,150});(case.{1,200}default:.{0,50}?return\(0,\i\.jsx\)\((?<searchComp>\i\.\i),)/,
                    replace: "$1 this?.state?.resultType === 'Favorites' ? $self.renderSearchBar(this, $<searchComp>) : $2;$3"
                },
                {
                    // to persist filtered favorites when component re-renders.
                    // when resizing the window the component rerenders and we loose the filtered favorites and have to type in the search bar to get them again
                    match: /(,suggestions:\i,favorites:)(\i),/,
                    replace: "$1$self.getFav($2),favCopy:$2,"
                }
            ]
        }
    ],

    settings,

    instance: null as Instance | null,
    renderSearchBar(instance: Instance, SearchBarComponent: TSearchBarComponent) {
        activeInstance = instance;
        this.instance = instance;
        return (
            <ErrorBoundary noop>
                <SearchBar instance={instance} SearchBarComponent={SearchBarComponent} />
            </ErrorBoundary>
        );
    },

    getFav(favorites: Gif[]) {
        if (!this.instance || this.instance.dead) return favorites;
        const { favorites: filteredFavorites } = this.instance.props;

        const favoritesToReturn = filteredFavorites != null && filteredFavorites?.length !== favorites.length ? filteredFavorites : favorites;

        // Check if we need to index favorites (only check the original favorites, not filtered ones)
        if (shouldIndex(favorites)) {
            indexFavorites(favorites);
        }

        return favoritesToReturn;
    }
});

function SearchBar({ instance, SearchBarComponent }: { instance: Instance; SearchBarComponent: TSearchBarComponent; }) {
    const [query, setQuery] = useState("");
    const [debouncedQuery, setDebouncedQuery] = useState("");
    const ref = useRef<{ containerRef?: React.RefObject<HTMLDivElement>; } | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Check for ranking weight changes and trigger indexing if needed
    useEffect(() => {
        if (instance.props.favCopy && shouldIndex(instance.props.favCopy)) {
            indexFavorites(instance.props.favCopy);
        }
    });

    const onChange = useCallback((searchQuery: string) => {
        setQuery(searchQuery);

        // Clear existing debounce timeout
        if (debounceTimeoutRef.current) {
            clearTimeout(debounceTimeoutRef.current);
        }

        // Cancel any ongoing request
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }

        // Handle empty query immediately
        if (searchQuery === "") {
            setDebouncedQuery("");
            const { props } = instance;
            props.favorites = props.favCopy;
            instance.forceUpdate();
            return;
        }

        // Debounce the search - wait 300ms after user stops typing
        debounceTimeoutRef.current = setTimeout(() => {
            setDebouncedQuery(searchQuery);
        }, 300);
    }, [instance]);

    // Effect to handle the actual search when debouncedQuery changes
    useEffect(() => {
        if (debouncedQuery === "") return;

        const performSearch = async () => {
            const uuid = settings.store.uuid;
            if (!uuid) return;

            const { props } = instance;

            // Create new AbortController for this request
            abortControllerRef.current = new AbortController();

            // scroll back to top
            ref.current?.containerRef?.current
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

                const data = await response.json() as {
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

                    const gif = props.favCopy.find(g => stripUrlParams(g.src) === stripUrlParams(url) || stripUrlParams(g.url) === stripUrlParams(url));
                    return gif ? { combinedScore: totalScore / totalWeight, gif } : null;
                }).filter(Boolean) as { combinedScore: number; gif: Gif; }[];

                aggregated.sort((a, b) => b.combinedScore - a.combinedScore);
                props.favorites = aggregated.map(e => e.gif);
                instance.forceUpdate();
            } catch (err: any) {
                if (err.name === "AbortError") {
                    console.log("Fetch aborted");
                    return;
                }
                console.error("Error fetching search results:", err);
                instance.forceUpdate();
            }
        };

        performSearch();
    }, [debouncedQuery, instance]);

    useEffect(() => {
        return () => {
            // Clear debounce timeout on unmount
            if (debounceTimeoutRef.current) {
                clearTimeout(debounceTimeoutRef.current);
            }
            // Cancel any ongoing request when component unmounts
            if (abortControllerRef.current) {
                abortControllerRef.current.abort();
            }
            instance.dead = true;
        };
    }, []);

    return (
        <SearchBarComponent
            ref={ref}
            autoFocus={true}
            size="md"
            className=""
            onChange={onChange}
            onClear={() => {
                // Clear debounce timeout when clearing
                if (debounceTimeoutRef.current) {
                    clearTimeout(debounceTimeoutRef.current);
                }
                // Cancel any ongoing request when clearing
                if (abortControllerRef.current) {
                    abortControllerRef.current.abort();
                }
                setQuery("");
                setDebouncedQuery("");
                if (instance.props.favCopy != null) {
                    instance.props.favorites = instance.props.favCopy;
                    instance.forceUpdate();
                }
            }}
            query={query}
            placeholder="Search Favorite Gifs"
        />
    );
}
