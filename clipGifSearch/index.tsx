/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2026 Vendicated and contributors
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
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Divider } from "@components/Divider";
import ErrorBoundary from "@components/ErrorBoundary";
import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { copyToClipboard } from "@utils/clipboard";
import { Devs } from "@utils/constants";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { Slider, TextInput, useCallback, useEffect, useRef, UserStore, useState } from "@webpack/common";

const logger = new Logger("ClipGifSearch");

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

interface IndexState {
    userId: string | null;
    indexedUrls: string[];
    indexedModels: Set<string>;
    pending: boolean;
    rankingWeights: Record<string, number>;
}

const indexState: IndexState = {
    userId: null,
    indexedUrls: [],
    indexedModels: new Set(),
    pending: false,
    rankingWeights: {},
};

function getModelWeights(): Record<string, number> {
    return settings.store.modelWeights ?? {};
}

function getAccountKey(): string | undefined {
    const keys = settings.store.accountKeys ??= {};
    return keys[UserStore.getCurrentUser().id];
}

function setAccountKey(key: string) {
    const keys = settings.store.accountKeys ??= {};
    keys[UserStore.getCurrentUser().id] = key;
}

function ensureAccountKey(): string {
    let key = getAccountKey();
    if (!key || key.length !== 32) {
        key = generateKey();
        setAccountKey(key);
    }
    return key;
}

function generateKey(): string {
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let key = "";
    for (let i = 0; i < 32; i++) {
        key += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return key;
}

function isValidGifSource(src: string): boolean {
    const httpsOffset = src.startsWith("https://") ? 8 : src.startsWith("http://") ? 7 : -1;
    if (httpsOffset === -1) return false;

    const pathIdx = src.indexOf("/", httpsOffset);
    const domain = src.substring(httpsOffset, pathIdx === -1 ? src.length : pathIdx);

    if (!domain || domain.length > 256) return false;
    return domain.endsWith(".discordapp.net") || domain === "media.tenor.co";
}

function getValidGifs(favorites: Gif[]): { name: string; src: string; }[] {
    const result: { name: string; src: string; }[] = [];

    for (const gif of favorites) {
        if (gif.url.length > 512 || gif.src.length > 2000) continue;
        if (!isValidGifSource(gif.src)) continue;
        result.push({ name: gif.url, src: gif.src });
    }

    return result;
}

function shouldIndex(favorites: Gif[]): boolean {
    if (indexState.userId !== UserStore.getCurrentUser().id) return true;

    const currentUrls = getValidGifs(favorites).map(g => g.name);
    if (currentUrls.length !== indexState.indexedUrls.length ||
        !currentUrls.every((url, i) => url === indexState.indexedUrls[i])) {
        return true;
    }

    const weights = getModelWeights();
    for (const [model, weight] of Object.entries(weights)) {
        if (weight > 0 && !indexState.indexedModels.has(model)) return true;
        if ((indexState.rankingWeights[model] ?? 0) === 0 && weight > 0) return true;
    }

    return false;
}

async function sendIndexRequest(favorites: Gif[]) {
    const key = getAccountKey();
    if (indexState.pending || !key || key.length !== 32) return;

    const validGifs = getValidGifs(favorites);
    if (validGifs.length === 0) return;

    const weights = getModelWeights();
    const models = Object.entries(weights).filter(([, w]) => w > 0).map(([name]) => name);
    if (models.length === 0) return;

    try {
        indexState.pending = true;
        const response = await fetch(`${settings.store.apiUrl}/${key}/index`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                names: validGifs.map(g => g.name),
                media_srcs: validGifs.map(g => g.src),
                models,
            }),
        });

        if (!response.ok) throw new Error(`Index request failed with status ${response.status}`);

        indexState.indexedUrls = validGifs.map(g => g.name);
        indexState.userId = UserStore.getCurrentUser().id;
        for (const model of models) indexState.indexedModels.add(model);
        indexState.rankingWeights = { ...weights };

        logger.info(`Indexed ${validGifs.length} favorites`);
    } catch (error) {
        logger.error("Failed to index favorites:", error);
    } finally {
        indexState.pending = false;
    }
}

function ModelWeightsComponent() {
    const [models, setModels] = useState<Record<string, number>>(() => getModelWeights());

    useEffect(() => {
        if (Object.keys(models).length > 0) return () => {};

        let cancelled = false;
        (async () => {
            try {
                const response = await fetch(`${settings.store.apiUrl}/models`);
                if (!response.ok || cancelled) return;
                const remote = await response.json() as Record<string, number>;
                const combined = { ...remote, ...getModelWeights() };
                if (!cancelled) {
                    setModels(combined);
                    settings.store.modelWeights = combined;
                }
            } catch {
                // API unavailable
            }
        })();

        return () => { cancelled = true; };
    }, []);

    const setModelWeight = useCallback((name: string, weight: number) => {
        setModels(prev => {
            const next = { ...prev, [name]: weight };
            settings.store.modelWeights = next;
            return next;
        });
    }, []);

    return (
        <section>
            <Heading tag="h3">CLIP Models</Heading>
            <Paragraph>
                Adjust how each model output is weighted when searching favorite GIFs.
            </Paragraph>

            <div style={{ marginTop: 8 }}>
                {Object.entries(models).map(([name, weight]) => (
                    <div key={name} style={{ marginBottom: 12 }}>
                        <Heading tag="h4">{name}</Heading>
                        <Flex style={{ alignItems: "center", gap: "0.75rem", marginTop: 6 }}>
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
                            <BaseText size="xs" style={{ width: 54, textAlign: "right", color: "var(--text-muted)" }}>
                                {(weight * 100).toFixed(0)}%
                            </BaseText>
                        </Flex>
                    </div>
                ))}
            </div>

            <Divider style={{ marginTop: 6 }} />
        </section>
    );
}

function StatusCountsComponent() {
    const [statusData, setStatusData] = useState<{ counts: Record<string, [number, number, number, number]>; } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchStatus = async () => {
            const key = getAccountKey();
            if (!key || key.length !== 32) {
                setError("No valid account key found");
                setLoading(false);
                return;
            }

            try {
                const response = await fetch(`${settings.store.apiUrl}/${key}/statuscounts`);
                if (!response.ok) throw new Error(`Status ${response.status}`);
                setStatusData(await response.json());
                setError(null);
            } catch (err: any) {
                setError(err.message ?? "Failed to fetch status");
            } finally {
                setLoading(false);
            }
        };

        fetchStatus();
        const interval = setInterval(fetchStatus, 5000);
        return () => clearInterval(interval);
    }, []);

    const statusLabels = ["Failed", "Downloading", "Processing", "Completed"];
    const statusColors = ["var(--status-danger)", "var(--status-warning)", "var(--brand-500)", "var(--status-positive)"];

    return (
        <section>
            <Heading tag="h3">GIF Processing Status</Heading>
            <Paragraph>
                Real time status of your GIF processing for each model.
            </Paragraph>

            <div style={{ marginTop: 12 }}>
                {loading && (
                    <BaseText size="sm" color="text-muted">
                        Loading status...
                    </BaseText>
                )}

                {error && (
                    <BaseText size="sm" color="text-danger">
                        {error}
                    </BaseText>
                )}

                {statusData?.counts && Object.entries(statusData.counts).map(([modelName, counts]) => (
                    <div key={modelName} style={{ marginBottom: 16, padding: 12, backgroundColor: "var(--background-secondary)", borderRadius: 8 }}>
                        <Heading tag="h4" style={{ marginBottom: 8 }}>{modelName}</Heading>
                        <Flex style={{ gap: "1rem", flexWrap: "wrap" }}>
                            {counts.map((count, i) => (
                                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: 60 }}>
                                    <BaseText size="lg" weight="semibold" style={{ color: statusColors[i] }}>
                                        {count}
                                    </BaseText>
                                    <BaseText size="xs" color="text-muted" style={{ textAlign: "center" }}>
                                        {statusLabels[i]}
                                    </BaseText>
                                </div>
                            ))}
                        </Flex>
                    </div>
                ))}

                {statusData && Object.keys(statusData.counts ?? {}).length === 0 && (
                    <BaseText size="sm" color="text-muted">
                        No processing data available.
                    </BaseText>
                )}
            </div>

            <Divider style={{ marginTop: 6 }} />
        </section>
    );
}

function UserKeyComponent() {
    const [userKey, setUserKey] = useState(() => getAccountKey() ?? "");
    const [isVisible, setIsVisible] = useState(false);

    const saveKey = useCallback((key: string) => {
        setAccountKey(key);
        setUserKey(key);
    }, []);

    return (
        <section>
            <Heading tag="h3">Account Key</Heading>
            <Paragraph>
                Your unique account key for the CLIP API. Automatically generated on first use.
            </Paragraph>

            <div style={{ marginTop: 12 }}>
                <Flex style={{ gap: "0.5rem", alignItems: "stretch" }}>
                    <div style={{ flex: 1 }}>
                        <TextInput
                            value={isVisible ? userKey : "\u2022".repeat(userKey.length)}
                            onChange={isVisible ? (v: string) => { setUserKey(v); setAccountKey(v); } : undefined}
                            placeholder="Enter 32 character key"
                            readOnly={!isVisible}
                            style={!isVisible ? { cursor: "default" } : undefined}
                        />
                    </div>
                    <Button
                        variant="secondary"
                        size="small"
                        onClick={() => setIsVisible(!isVisible)}
                    >
                        {isVisible ? "Hide" : "Show"}
                    </Button>
                    <Button
                        variant="secondary"
                        size="small"
                        onClick={() => copyToClipboard(userKey)}
                    >
                        Copy
                    </Button>
                    <Button
                        variant="secondary"
                        size="small"
                        onClick={() => saveKey(generateKey())}
                    >
                        Generate New
                    </Button>
                </Flex>
                {userKey.length > 0 && userKey.length !== 32 && (
                    <BaseText size="xs" style={{ color: "var(--status-warning)", marginTop: 4 }}>
                        Key should be exactly 32 characters.
                    </BaseText>
                )}
            </div>

            <Divider style={{ marginTop: 12 }} />
        </section>
    );
}

export const settings = definePluginSettings({
    apiUrl: {
        type: OptionType.STRING,
        description: "CLIP API URL.",
        default: "https://gif-search.woodie.dev",
    },
    modelWeightsComponent: {
        type: OptionType.COMPONENT,
        description: "CLIP model weights.",
        component: ModelWeightsComponent,
    },
    statusCountsComponent: {
        type: OptionType.COMPONENT,
        description: "GIF processing status.",
        component: StatusCountsComponent,
    },
    userKeyComponent: {
        type: OptionType.COMPONENT,
        description: "Account key management.",
        component: UserKeyComponent,
    },
}).withPrivateSettings<{
    accountKeys?: Record<string, string>;
    modelWeights?: Record<string, number>;
}>();

export default definePlugin({
    name: "ClipGifSearch",
    authors: [Devs.Aria, { name: "Woodie", id: 851073836152651777n }],
    description: "Adds a CLIP powered search bar to favorite GIFs.",

    settings,

    patches: [
        {
            find: "renderHeaderContent()",
            replacement: [
                {
                    match: /(renderHeaderContent\(\).{1,150}FAVORITES:return)(.{1,150});(case.{1,200}default:.{0,50}?return\(0,\i\.jsx\)\((?<searchComp>\i\..{1,10}),)/,
                    replace: "$1 this.state.resultType === 'Favorites' ? $self.renderSearchBar(this, $<searchComp>) : $2;$3",
                },
                {
                    match: /(,suggestions:\i,favorites:)(\i),/,
                    replace: "$1$self.getFav($2),favCopy:$2,",
                },
            ],
        },
    ],

    instance: null as Instance | null,

    start() {
        indexState.rankingWeights = { ...getModelWeights() };

        (async () => {
            try {
                const response = await fetch(`${settings.store.apiUrl}/models`);
                if (!response.ok) return;
                const models = await response.json() as Record<string, number>;
                const current = getModelWeights();
                let changed = false;
                for (const [name, weight] of Object.entries(models)) {
                    if (current[name] === undefined) {
                        current[name] = weight;
                        changed = true;
                    }
                }
                if (changed) {
                    settings.store.modelWeights = current;
                    indexState.rankingWeights = { ...current };
                }
            } catch {
                // API unavailable
            }
        })();
    },

    renderSearchBar(instance: Instance, SearchBarComponent: TSearchBarComponent) {
        this.instance = instance;
        return (
            <ErrorBoundary noop>
                <SearchBar instance={instance} SearchBarComponent={SearchBarComponent} />
            </ErrorBoundary>
        );
    },

    getFav(favorites: Gif[]) {
        if (!this.instance || this.instance.dead) return favorites;

        ensureAccountKey();

        if (shouldIndex(favorites)) {
            sendIndexRequest(favorites);
        }

        const { favorites: filtered } = this.instance.props;
        return filtered != null && filtered.length !== favorites.length ? filtered : favorites;
    },
});

function SearchBar({ instance, SearchBarComponent }: { instance: Instance; SearchBarComponent: TSearchBarComponent; }) {
    const [query, setQuery] = useState("");
    const ref = useRef<{ containerRef?: React.RefObject<HTMLDivElement>; } | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (instance.props.favCopy && shouldIndex(instance.props.favCopy)) {
            sendIndexRequest(instance.props.favCopy);
        }
    });

    const performSearch = useCallback(async (searchQuery: string) => {
        abortControllerRef.current?.abort();

        const key = getAccountKey();
        if (!key || key.length !== 32) return;

        const weights = getModelWeights();
        const models = Object.entries(weights).filter(([, w]) => w > 0).map(([name]) => name);
        if (models.length === 0) return;

        abortControllerRef.current = new AbortController();

        ref.current?.containerRef?.current
            ?.closest("#gif-picker-tab-panel")
            ?.querySelector("[class|=\"content\"]")
            ?.firstElementChild?.scrollTo(0, 0);

        try {
            const response = await fetch(
                `${settings.store.apiUrl}/${key}/search?text=${encodeURIComponent(searchQuery)}&models=${encodeURIComponent(models.join(","))}&k=10000`,
                { signal: abortControllerRef.current.signal },
            );

            if (!response.ok) throw new Error(`Search failed with status ${response.status}`);

            const data = await response.json();
            const modelResults = data.results as Record<string, [string, number][]>;

            const rankingMaps = new Map<string, Map<string, number>>();
            for (const [modelId, results] of Object.entries(modelResults)) {
                const sorted = [...results].sort((a, b) => a[1] - b[1]);
                const map = new Map<string, number>();
                sorted.forEach(([url], idx) => map.set(url, idx + 1));
                rankingMaps.set(modelId, map);
            }

            const allUrls = new Set<string>();
            for (const results of Object.values(modelResults)) {
                for (const [url] of results) allUrls.add(url);
            }

            const scored = Array.from(allUrls).map(url => {
                let totalScore = 0;
                let totalWeight = 0;

                for (const [modelId, rankMap] of rankingMaps) {
                    const weight = weights[modelId] ?? 0.5;
                    const rank = rankMap.get(url);
                    if (rank != null) {
                        totalScore += (1 / rank) * weight;
                        totalWeight += weight;
                    }
                }

                if (totalWeight === 0) return null;

                const gif = instance.props.favCopy.find(g => g.url === url);
                return gif ? { score: totalScore / totalWeight, gif } : null;
            }).filter((x): x is { score: number; gif: Gif; } => x != null);

            scored.sort((a, b) => b.score - a.score);
            instance.props.favorites = scored.map(e => e.gif);
            instance.forceUpdate();
        } catch (err: any) {
            if (err.name === "AbortError") return;
            logger.error("Search failed:", err);
        }
    }, [instance]);

    const onChange = useCallback((searchQuery: string) => {
        setQuery(searchQuery);

        if (debounceRef.current) clearTimeout(debounceRef.current);
        abortControllerRef.current?.abort();

        if (searchQuery === "") {
            instance.props.favorites = instance.props.favCopy;
            instance.forceUpdate();
            return;
        }

        debounceRef.current = setTimeout(() => performSearch(searchQuery), 300);
    }, [instance, performSearch]);

    const onClear = useCallback(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        abortControllerRef.current?.abort();
        setQuery("");
        if (instance.props.favCopy != null) {
            instance.props.favorites = instance.props.favCopy;
            instance.forceUpdate();
        }
    }, [instance]);

    useEffect(() => () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        abortControllerRef.current?.abort();
        instance.dead = true;
    }, []);

    return (
        <SearchBarComponent
            ref={ref}
            autoFocus={true}
            size="md"
            className=""
            onChange={onChange}
            onClear={onClear}
            query={query}
            placeholder="CLIP Search Favorite GIFs"
        />
    );
}
