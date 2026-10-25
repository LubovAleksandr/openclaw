/** @jsxImportSource @solidjs/web */
import { render } from "@solidjs/web";
import type {
  ControlUiSettingsSnapshot,
  ControlUiSettingsView,
  DoctorMemoryStatusPayload,
} from "openclaw/plugin-sdk/control-ui";
import { createMemo, createSignal, Errored, isPending, latest, lazy, Loading } from "solid-js";
import { createTranslator } from "./i18n/index.ts";
import { loadMessages } from "./i18n/locales.ts";
import type { MemoryOverviewStatus } from "./overview.tsx";

const MemoryMemories = lazy(() => import("./memories.tsx"), { export: "MemoryMemories" });

export const memoriesView: ControlUiSettingsView = {
  placement: { section: "memory", panel: "memories" },
  mount(container, context) {
    void loadMessages(context.props.locale);
    // Only the host's imperative lifetime writes this presentation projection.
    const [snapshot, setSnapshot] = createSignal(context.props, { ownedWrite: true });
    const dispose = render(() => {
      const t = createTranslator(() => snapshot().locale);
      return (
        <Errored
          fallback={(error, retry) => (
            <div class="callout danger" role="alert">
              <p>{context.formatError(error())}</p>
              <button class="btn btn--sm" onClick={retry}>
                {t("memoryPage.memories.retry")}
              </button>
            </div>
          )}
        >
          <Loading fallback={<p role="status">{t("common.loading")}</p>}>
            <MemoryMemories context={context} snapshot={snapshot()} />
          </Loading>
        </Errored>
      );
    }, container);
    return {
      update(next) {
        void loadMessages(next.locale);
        setSnapshot(next);
      },
      dispose,
    };
  },
};

export const pluginId = "memory-core";
export const settingsViews: readonly ControlUiSettingsView[] = [
  {
    placement: { section: "memory", panel: "overview" },
    mount(container, context) {
      void loadMessages(context.props.locale);
      let current = context.props;
      let active = true;
      let request: object | undefined;
      let reset = {};
      const [snapshot, setSnapshot] = createSignal(current, { ownedWrite: true });
      const [receipt, setReceipt] = createSignal<
        | {
            result: Promise<DoctorMemoryStatusPayload | null>;
            probe: boolean;
            reset: object;
          }
        | undefined
      >(undefined, { ownedWrite: true });
      const scope = (value: ControlUiSettingsSnapshot) =>
        JSON.stringify([
          value.agentId,
          value.engine,
          value.connected,
          value.connectionEpoch,
          value.routeIntent,
        ]);

      function load(force = false, probe = false) {
        if (!active || context.signal.aborted) {
          return;
        }
        if (current.engine.kind === "off" || !current.connected || !current.agentId) {
          request = undefined;
          setReceipt(undefined);
          return;
        }
        if (request && !force) {
          return;
        }
        const pending = {};
        request = pending;
        if (!probe) {
          reset = {};
        }
        const result = context
          .request<DoctorMemoryStatusPayload>("doctor.memory.status", {
            agentId: current.agentId,
            ...(probe ? { probe: true } : {}),
          })
          .then((payload) =>
            active && request === pending && !context.signal.aborted ? payload : null,
          )
          .catch((error: unknown) => {
            if (!active || request !== pending || context.signal.aborted) {
              return null;
            }
            throw error;
          });
        setReceipt({ result, probe, reset });
        void result.catch(() => undefined);
      }

      function Overview() {
        const t = createTranslator(() => snapshot().locale);
        const MemoryOverview = lazy(async () => {
          const { createMemoryOverview } = await import("./overview.tsx");
          return { default: createMemoryOverview(context, snapshot) };
        });
        // Advance the admitted request and selected scope together before old data settles.
        const payload = createMemo(() => {
          const selected = latest(snapshot);
          if (!selected.agentId && selected.agentsError) {
            throw new Error(selected.agentsError);
          }
          if (selected.engine.kind === "off" || !selected.agentId) {
            return null;
          }
          if (!selected.connected) {
            throw new Error(t("memoryPage.overview.hero.gatewayOffline"));
          }
          return latest(receipt)?.result ?? null;
        });
        // A probe keeps the accepted cards; explicit refreshes show the waking state.
        const loadingReset = createMemo(() => receipt()?.reset);
        function Presentation(props: { status: MemoryOverviewStatus; probing?: boolean }) {
          return (
            <MemoryOverview
              agentId={snapshot().agentId}
              engineSelection={snapshot().engine}
              engineDisabled={snapshot().engine.availability === "disabled"}
              status={props.status}
              probingEmbeddings={props.probing === true}
              onRefresh={() => {
                if (!active || context.signal.aborted) {
                  return;
                }
                if (current.agentId) {
                  load(true);
                } else {
                  context.refreshAgents();
                }
              }}
              onProbeEmbeddings={() => load(true, true)}
              onNavigate={context.navigate}
            />
          );
        }
        const status = (): MemoryOverviewStatus => {
          const accepted = latest(receipt)?.probe ? latest(payload) : payload();
          return accepted ? { kind: "ready", payload: accepted } : { kind: "idle" };
        };
        return (
          <Errored
            fallback={(error, retry) => (
              <div class="callout danger" role="alert">
                <p>{context.formatError(error())}</p>
                <button class="btn btn--sm" onClick={retry}>
                  {t("memoryPage.overview.hero.retry")}
                </button>
              </div>
            )}
          >
            <Loading fallback={<p role="status">{t("common.loading")}</p>}>
              <Loading
                on={latest(loadingReset)}
                fallback={<Presentation status={{ kind: "loading" }} />}
              >
                <Errored
                  fallback={(error) => (
                    <Presentation
                      status={{ kind: "error", message: context.formatError(error()) }}
                    />
                  )}
                >
                  <Presentation
                    status={status()}
                    probing={latest(receipt)?.probe && isPending(payload)}
                  />
                </Errored>
              </Loading>
            </Loading>
          </Errored>
        );
      }
      const stop = render(() => <Overview />, container);
      load();
      return {
        update(next) {
          if (!active || context.signal.aborted) {
            return;
          }
          const changedScope = scope(current) !== scope(next);
          void loadMessages(next.locale);
          current = next;
          setSnapshot(next);
          if (changedScope) {
            request = undefined;
            load();
          }
        },
        dispose() {
          active = false;
          request = undefined;
          stop();
        },
      };
    },
  },
  memoriesView,
];
