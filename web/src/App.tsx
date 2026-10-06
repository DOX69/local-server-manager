import {
  Activity,
  ArrowDown,
  ArrowUp,
  Box,
  Check,
  ChevronDown,
  CircleHelp,
  CircleDot,
  Clock3,
  Cpu,
  ExternalLink,
  FolderGit2,
  GitBranch,
  HardDrive,
  LoaderCircle,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  X,
  Zap,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

type View = "servers" | "containers" | "worktrees"

type ServerRow = {
  name: string
  protocol: string
  port: number
  pid: number
  repo?: string
  cwd?: string
  agent: string
  connections: number
  memory: number
  cpu: number
  started?: number | null
  stoppable: boolean
  containers?: string[]
  bindings: string[]
  evidence: string
  clients: { name?: string; pid: number; endpoint: string }[]
  ancestry: { name: string; pid: number; cwd?: string; command?: string }[]
}

type ContainerRow = {
  id: string
  name: string
  image: string
  project?: string
  service?: string
  directory?: string
  started?: string
  state: string
  health?: string
  stoppable: boolean
  ports: { host_ip: string; host_port: number; container_port: number }[]
}

type WorktreeRow = {
  path: string
  repo: string
  branch: string
  kind: string
  servers: number
  exists: boolean
  locked: boolean
}

type ResourceRow = ServerRow | ContainerRow | WorktreeRow

type Snapshot = {
  hostname?: string
  loading?: boolean
  servers: ServerRow[]
  containers: ContainerRow[]
  worktrees: WorktreeRow[]
  warnings?: string[]
  timestamp?: number
  scan_ms?: number
}

type Column = {
  key: string
  label: string
  value: (row: ResourceRow) => string
  sort: (row: ResourceRow) => string | number
  render: (row: ResourceRow) => ReactNode
}

type Sort = { key: string; direction: "asc" | "desc" } | null
type StopTarget =
  | { kind: "process"; pid: number; started?: number | null; name: string; port: number }
  | { kind: "container"; id: string; started?: string; name: string }
type DetailTarget = { view: View; row: ResourceRow } | null

const initialSnapshot: Snapshot = { loading: true, servers: [], containers: [], worktrees: [] }
const views: { key: View; label: string; icon: typeof Server }[] = [
  { key: "servers", label: "Serveurs", icon: Server },
  { key: "containers", label: "Docker", icon: Box },
  { key: "worktrees", label: "Worktrees", icon: GitBranch },
]

const titles: Record<View, { title: string; intro: string; list: string; filter: string }> = {
  servers: {
    title: "Serveurs locaux",
    intro: "Ports ouverts, processus associés et clients connectés sur ce PC.",
    list: "Processus en écoute",
    filter: "Origine",
  },
  containers: {
    title: "Conteneurs Docker",
    intro: "Conteneurs actifs ou arrêtés, ports publiés et projets Compose.",
    list: "Conteneurs sur ce PC",
    filter: "Origine",
  },
  worktrees: {
    title: "Worktrees Git",
    intro: "Copies de travail découvertes, y compris celles sans serveur actif.",
    list: "Copies de travail détectées",
    filter: "Type",
  },
}

function basename(path?: string) {
  return path?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || "Projet non identifié"
}

function shortPath(path?: string) {
  return (path || "").replace(/\\/g, "/").replace(/^.*\/.codex\/worktrees\//, "…/worktrees/")
}

function age(started?: number | null) {
  if (!started) return "Inconnu"
  const seconds = Math.max(0, Date.now() / 1000 - started)
  if (seconds < 60) return `${Math.floor(seconds)} s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`
  return `${Math.floor(seconds / 86400)} j`
}

function serverOrigin(row: ServerRow) {
  const parts = [row.agent]
  if (row.repo?.includes("/.codex/") || row.repo?.includes("\\.codex\\")) parts.push("Worktree Codex")
  if (row.containers?.length) parts.push(`Docker · ${row.containers.join(", ")}`)
  return parts.filter(Boolean).join(" · ")
}

function containerPorts(row: ContainerRow) {
  return row.ports.map((port) => `${port.host_ip}:${port.host_port} → ${port.container_port}`).join(", ") || "Non publié"
}

function getColumns(view: View): Column[] {
  if (view === "servers") {
    return [
      {
        key: "endpoint",
        label: "Port / protocole",
        value: (row) => {
          const server = row as ServerRow
          return `${server.protocol}:${server.port}`
        },
        sort: (row) => (row as ServerRow).port,
        render: (row) => {
          const server = row as ServerRow
          const port = <><span className="mono port-number">:{server.port}</span><span className="cell-sub">{server.protocol} · PID {server.pid}</span></>
          return server.protocol === "TCP" ? (
            <a className="port-link" href={`http://localhost:${server.port}`} target="_blank" rel="noopener noreferrer" title={`Ouvrir le port ${server.port}`}>
              {port}<ExternalLink aria-hidden="true" />
            </a>
          ) : port
        },
      },
      {
        key: "project",
        label: "Projet / processus",
        value: (row) => {
          const server = row as ServerRow
          return (server.repo || server.cwd || server.name).toLowerCase()
        },
        sort: (row) => basename((row as ServerRow).repo || (row as ServerRow).cwd),
        render: (row) => {
          const server = row as ServerRow
          const location = server.repo || server.cwd
          return <><span className="cell-primary">{server.repo ? basename(server.repo) : server.name}</span><span className="cell-sub path-label" title={location}>{location ? shortPath(location) : "Dossier inaccessible"}</span></>
        },
      },
      {
        key: "origin",
        label: "Origine",
        value: (row) => serverOrigin(row as ServerRow).toLowerCase(),
        sort: (row) => (row as ServerRow).agent,
        render: (row) => {
          const server = row as ServerRow
          return <div className="cell-stack"><OriginBadge origin={server.agent} />{server.repo?.includes("/.codex/") || server.repo?.includes("\\.codex\\") ? <span className="cell-sub">Worktree Codex</span> : null}{server.containers?.length ? <span className="cell-sub">Docker · {server.containers.join(", ")}</span> : null}</div>
        },
      },
      {
        key: "usage",
        label: "Utilisation",
        value: (row) => String((row as ServerRow).connections),
        sort: (row) => (row as ServerRow).connections,
        render: (row) => {
          const server = row as ServerRow
          return <><span>{server.connections} connexion{server.connections !== 1 ? "s" : ""}</span><span className="cell-sub">{(server.memory / 1048576).toFixed(0)} Mo · {server.cpu.toFixed(1)} % CPU</span></>
        },
      },
      {
        key: "started",
        label: "Depuis",
        value: (row) => String((row as ServerRow).started || "unknown"),
        sort: (row) => (row as ServerRow).started ? Date.now() / 1000 - ((row as ServerRow).started || 0) : Number.POSITIVE_INFINITY,
        render: (row) => <span className="mono">{age((row as ServerRow).started)}</span>,
      },
      {
        key: "actions",
        label: "Actions",
        value: (row) => (row as ServerRow).stoppable ? "stoppable" : "protected",
        sort: (row) => ((row as ServerRow).stoppable ? 0 : 1),
        render: (row) => (row as ServerRow).stoppable ? <Badge variant="outline" className="status-ready"><CircleDot aria-hidden="true" />Arrêtable</Badge> : <Badge variant="secondary"><ShieldCheck aria-hidden="true" />Protégé</Badge>,
      },
    ]
  }

  if (view === "containers") {
    return [
      {
        key: "container",
        label: "Conteneur / image",
        value: (row) => `${(row as ContainerRow).name}|${(row as ContainerRow).image}`.toLowerCase(),
        sort: (row) => (row as ContainerRow).name,
        render: (row) => <><span className="cell-primary">{(row as ContainerRow).name}</span><span className="cell-sub path-label">{(row as ContainerRow).image}</span></>,
      },
      {
        key: "project",
        label: "Projet Compose",
        value: (row) => `${(row as ContainerRow).project || "Hors Compose"}|${(row as ContainerRow).service || ""}`.toLowerCase(),
        sort: (row) => `${(row as ContainerRow).project || "Hors Compose"} · ${(row as ContainerRow).service || ""}`,
        render: (row) => <><span>{(row as ContainerRow).project || "Hors Compose"}</span><span className="cell-sub">{(row as ContainerRow).service || ""}</span></>,
      },
      {
        key: "ports",
        label: "Ports publiés",
        value: (row) => containerPorts(row as ContainerRow),
        sort: (row) => containerPorts(row as ContainerRow),
        render: (row) => <span className="mono path-label">{containerPorts(row as ContainerRow)}</span>,
      },
      {
        key: "state",
        label: "État",
        value: (row) => `${(row as ContainerRow).state}|${(row as ContainerRow).health || ""}`.toLowerCase(),
        sort: (row) => (row as ContainerRow).state,
        render: (row) => <div className="cell-stack"><StateBadge state={(row as ContainerRow).state} />{(row as ContainerRow).health ? <span className="cell-sub">{(row as ContainerRow).health}</span> : null}</div>,
      },
      {
        key: "actions",
        label: "Actions",
        value: (row) => (row as ContainerRow).stoppable ? "arrêtable" : (row as ContainerRow).state === "running" ? "protégé" : "arrêté",
        sort: (row) => ((row as ContainerRow).stoppable ? 0 : (row as ContainerRow).state === "running" ? 1 : 2),
        render: (row) => (row as ContainerRow).stoppable ? <Badge variant="outline" className="status-ready"><CircleDot aria-hidden="true" />Arrêtable</Badge> : <Badge variant="secondary"><ShieldCheck aria-hidden="true" />{(row as ContainerRow).state === "running" ? "Protégé" : "Arrêté"}</Badge>,
      },
    ]
  }

  return [
    {
      key: "project",
      label: "Projet / worktree",
      value: (row) => (row as WorktreeRow).path.toLowerCase(),
      sort: (row) => `${basename((row as WorktreeRow).repo)} · ${shortPath((row as WorktreeRow).path)}`,
      render: (row) => <><span className="cell-primary">{basename((row as WorktreeRow).repo)}</span><span className="cell-sub path-label" title={(row as WorktreeRow).path}>{shortPath((row as WorktreeRow).path)}</span></>,
    },
    {
      key: "branch",
      label: "Branche",
      value: (row) => (row as WorktreeRow).branch,
      sort: (row) => (row as WorktreeRow).branch,
      render: (row) => <span className="mono path-label">{(row as WorktreeRow).branch}</span>,
    },
    {
      key: "kind",
      label: "Type",
      value: (row) => (row as WorktreeRow).kind,
      sort: (row) => (row as WorktreeRow).kind,
      render: (row) => <Badge variant="outline" className="status-violet"><GitBranch aria-hidden="true" />{(row as WorktreeRow).kind}</Badge>,
    },
    {
      key: "servers",
      label: "Serveurs",
      value: (row) => String((row as WorktreeRow).servers || 0),
      sort: (row) => (row as WorktreeRow).servers || 0,
      render: (row) => (row as WorktreeRow).servers ? <span className="live-value"><span className="status-dot" />{(row as WorktreeRow).servers} port{(row as WorktreeRow).servers !== 1 ? "s" : ""}</span> : <span className="text-muted">Aucun serveur</span>,
    },
    {
      key: "state",
      label: "État",
      value: (row) => `${(row as WorktreeRow).exists}|${(row as WorktreeRow).locked}`,
      sort: (row) => `${(row as WorktreeRow).exists ? "Présent" : "Dossier absent"} · ${(row as WorktreeRow).locked ? "Verrouillé" : ""}`,
      render: (row) => <div className="cell-stack"><Badge variant="outline" className={(row as WorktreeRow).exists ? "status-ready" : "status-warning"}>{(row as WorktreeRow).exists ? "Présent" : "Dossier absent"}</Badge>{(row as WorktreeRow).locked ? <span className="cell-sub">Verrouillé</span> : null}</div>,
    },
  ]
}

function OriginBadge({ origin }: { origin: string }) {
  if (origin === "Inconnu") return <Badge variant="secondary"><CircleHelp aria-hidden="true" />Inconnu</Badge>
  return <Badge variant="outline" className={origin === "OpenCode" ? "status-violet" : "status-cyan"}><Zap aria-hidden="true" />{origin}</Badge>
}

function StateBadge({ state }: { state: string }) {
  const isRunning = state === "running"
  return <Badge variant="outline" className={isRunning ? "status-ready" : "status-idle"}><span className={isRunning ? "status-dot" : "status-dot status-dot-muted"} />{isRunning ? "En cours" : state}</Badge>
}

function App() {
  const [view, setView] = useState<View>("servers")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [connection, setConnection] = useState<"connecting" | "connected" | "stale">("connecting")
  const [refreshing, setRefreshing] = useState(false)
  const [search, setSearch] = useState("")
  const [agent, setAgent] = useState("all")
  const [includeSystem, setIncludeSystem] = useState(false)
  const [columnFilters, setColumnFilters] = useState<Record<View, Record<string, string[]>>>({ servers: {}, containers: {}, worktrees: {} })
  const [sorting, setSorting] = useState<Record<View, Sort>>({ servers: null, containers: null, worktrees: null })
  const [detail, setDetail] = useState<DetailTarget>(null)
  const [stopTarget, setStopTarget] = useState<StopTarget | null>(null)
  const [stopping, setStopping] = useState(false)
  const [toast, setToast] = useState("")
  const token = useRef("")
  const requestInFlight = useRef(false)
  const lastGood = useRef(false)
  const toastTimer = useRef<number | undefined>(undefined)

  const refresh = useCallback(async () => {
    if (requestInFlight.current) return
    requestInFlight.current = true
    setRefreshing(true)
    try {
      if (!token.current) {
        const session = await fetch("/api/session")
        if (!session.ok) throw new Error(`Erreur ${session.status}`)
        token.current = (await session.json() as { token: string }).token
      }
      const response = await fetch("/api/snapshot", { headers: { "X-Localdeck-Token": token.current } })
      const result = await response.json() as Snapshot & { error?: string }
      if (!response.ok) throw new Error(result.error || `Erreur ${response.status}`)
      setSnapshot(result)
      setConnection("connected")
      lastGood.current = true
    } catch {
      setConnection("stale")
      if (!lastGood.current) setSnapshot(null)
    } finally {
      requestInFlight.current = false
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(() => void refresh(), 8000)
    return () => {
      window.clearInterval(interval)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [refresh])

  useEffect(() => {
    setSearch("")
    setAgent("all")
    setDetail(null)
  }, [view])

  const showToast = useCallback((message: string) => {
    setToast(message)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(""), 6500)
  }, [])

  async function stopResource() {
    if (!stopTarget || stopping) return
    setStopping(true)
    const body = stopTarget.kind === "container"
      ? { kind: "container", id: stopTarget.id, started: stopTarget.started }
      : { kind: "process", pid: stopTarget.pid, started: stopTarget.started }
    try {
      const response = await fetch("/api/stop", {
        method: "POST",
        headers: { "X-Localdeck-Token": token.current, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const result = await response.json() as { message?: string; error?: string }
      if (!response.ok) throw new Error(result.error || `Erreur ${response.status}`)
      setStopTarget(null)
      showToast(result.message || "Ressource arrêtée.")
      await refresh()
      window.setTimeout(() => void refresh(), 10000)
    } catch (error) {
      setStopTarget(null)
      showToast(error instanceof Error ? error.message : "Impossible d’arrêter cette ressource.")
    } finally {
      setStopping(false)
    }
  }

  function changeView(value: string) {
    if (value === "servers" || value === "containers" || value === "worktrees") setView(value)
  }

  const counts = {
    servers: snapshot ? new Set(snapshot.servers.filter((row) => row.stoppable).map((row) => row.pid)).size : "—",
    containers: snapshot ? snapshot.containers.filter((row) => row.state === "running").length : "—",
    worktrees: snapshot ? snapshot.worktrees.filter((row) => row.servers > 0).length : "—",
  }

  const closeStopDialog = (open: boolean) => {
    if (!open && !stopping) setStopTarget(null)
  }

  return (
    <TooltipProvider>
      <Tabs value={view} onValueChange={changeView} orientation="vertical" className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
        <aside className="side-panel">
          <div className="brand-row">
            <a className="brand" href="/" aria-label="Localdeck, accueil">
              <span className="brand-mark"><Server aria-hidden="true" /></span>
              <span className="brand-name">LOCAL<span>DECK</span><small>LOCAL SYSTEMS / 01</small></span>
            </a>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="sidebar-toggle" aria-label={sidebarCollapsed ? "Déplier le panneau latéral" : "Réduire le panneau latéral"} onClick={() => setSidebarCollapsed((value) => !value)}>
                  {sidebarCollapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{sidebarCollapsed ? "Déplier le panneau" : "Réduire le panneau"}</TooltipContent>
            </Tooltip>
          </div>

          <Card size="sm" className="host-card">
            <CardContent className="host-content">
              <span className="host-avatar"><HardDrive aria-hidden="true" /></span>
              <span className="host-copy"><span className="eyebrow">HÔTE ACTIF</span><strong>{snapshot?.hostname || "PC Windows"}</strong><span className="host-address"><span className="status-dot" />127.0.0.1 · PRIVÉ</span></span>
            </CardContent>
          </Card>

          <div className="side-caption"><span>ESPACE DE TRAVAIL</span><span>03</span></div>
          <TabsList className="nav-tabs" variant="line" aria-label="Inventaire local">
            {views.map(({ key, label, icon: Icon }, index) => (
              <TabsTrigger key={key} value={key} className="nav-trigger">
                <span className="nav-glyph"><Icon aria-hidden="true" /></span>
                <span className="nav-label">{label}<small>{["PROCESSUS", "CONTENEURS", "DÉPÔTS GIT"][index]}</small></span>
                <Badge variant="outline" className="nav-count">{counts[key]}</Badge>
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="sidebar-spacer" />
          <Separator className="sidebar-rule" />
          <div className="local-proof">
            <span className="local-proof-icon"><ShieldCheck aria-hidden="true" /></span>
            <div><strong>LOCAL UNIQUEMENT</strong><span>Aucune donnée ne quitte ce PC.</span></div>
          </div>
          <div className="side-version"><span>LOCALDECK // MONITOR</span><span>BUILD 0.1</span></div>
        </aside>

        <section className="workspace">
          <header className="topbar">
            <div className="breadcrumbs"><span>LOCALHOST</span><ChevronDown aria-hidden="true" /><strong>MONITORING</strong></div>
            <div className="topbar-right">
              <span className={`connection-pill ${connection === "stale" ? "connection-stale" : ""}`}><span className="status-dot" />{connection === "connected" ? "Collecteur connecté" : connection === "stale" ? "Collecteur indisponible" : "Connexion…"}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={refreshing} className="refresh-button">
                    {refreshing ? <LoaderCircle className="spin" data-icon="inline-start" aria-hidden="true" /> : <RefreshCw data-icon="inline-start" aria-hidden="true" />}
                    Actualiser
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Relire le dernier inventaire du collecteur</TooltipContent>
              </Tooltip>
            </div>
          </header>

          {views.map(({ key }) => (
            <TabsContent key={key} value={key} className="view-content">
              <DashboardView
                view={key}
                snapshot={snapshot}
                connection={connection}
                search={search}
                onSearch={setSearch}
                agent={agent}
                onAgent={setAgent}
                includeSystem={includeSystem}
                onIncludeSystem={setIncludeSystem}
                columnFilters={columnFilters[key]}
                onColumnFilters={(filters) => setColumnFilters((current) => ({ ...current, [key]: filters }))}
                sort={sorting[key]}
                onSort={(sort) => setSorting((current) => ({ ...current, [key]: sort }))}
                onDetail={(row) => setDetail({ view: key, row })}
                onStop={setStopTarget}
              />
            </TabsContent>
          ))}
          <p className="privacy-footnote"><ShieldCheck aria-hidden="true" />Scan local toutes les 8 s <span>·</span> Les processus système et Localdeck restent protégés.</p>
        </section>

        <DetailSheet detail={detail} onOpenChange={(open) => !open && setDetail(null)} />
        <AlertDialog open={!!stopTarget} onOpenChange={closeStopDialog}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <div className="confirm-icon"><ShieldAlert aria-hidden="true" /></div>
              <AlertDialogTitle>Arrêter cette ressource ?</AlertDialogTitle>
              <AlertDialogDescription>
                {stopTarget?.kind === "container"
                  ? `Le conteneur « ${stopTarget.name} » va être arrêté. Ses volumes seront conservés.`
                  : stopTarget ? `Le processus ${stopTarget.name}, PID ${stopTarget.pid}, sera terminé. Tous ses ports seront fermés, dont ${stopTarget.port}. Un superviseur peut le relancer.` : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={stopping}>Annuler</AlertDialogCancel>
              <AlertDialogAction onClick={(event) => { event.preventDefault(); void stopResource() }} disabled={stopping} className="confirm-stop">
                {stopping ? <LoaderCircle className="spin" data-icon="inline-start" aria-hidden="true" /> : <ShieldAlert data-icon="inline-start" aria-hidden="true" />}
                {stopping ? "Arrêt en cours…" : "Arrêter"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {toast ? <div className="toast-message" role="status"><Check aria-hidden="true" />{toast}<button type="button" aria-label="Fermer la notification" onClick={() => setToast("")}><X aria-hidden="true" /></button></div> : null}
      </Tabs>
    </TooltipProvider>
  )
}

type DashboardViewProps = {
  view: View
  snapshot: Snapshot | null
  connection: "connecting" | "connected" | "stale"
  search: string
  onSearch: (value: string) => void
  agent: string
  onAgent: (value: string) => void
  includeSystem: boolean
  onIncludeSystem: (value: boolean) => void
  columnFilters: Record<string, string[]>
  onColumnFilters: (value: Record<string, string[]>) => void
  sort: Sort
  onSort: (value: Sort) => void
  onDetail: (row: ResourceRow) => void
  onStop: (target: StopTarget) => void
}

function DashboardView(props: DashboardViewProps) {
  const { view, snapshot, connection, search, onSearch, agent, onAgent, includeSystem, onIncludeSystem, columnFilters, onColumnFilters, sort, onSort, onDetail, onStop } = props
  const title = titles[view]
  const data = snapshot || initialSnapshot
  const allRows: ResourceRow[] = data[view]
  const columns = useMemo(() => getColumns(view), [view])
  const baseRows = useMemo(() => allRows.filter((row) => {
    if (view === "servers") {
      const server = row as ServerRow
      if (!includeSystem && !server.stoppable && !server.repo && server.agent === "Inconnu" && !server.containers?.length) return false
      if (agent !== "all" && server.agent !== agent) return false
    }
    if (view === "worktrees" && agent !== "all" && (row as WorktreeRow).kind !== agent) return false
    return JSON.stringify(row).toLowerCase().includes(search.trim().toLowerCase())
  }), [allRows, view, includeSystem, agent, search])
  const visibleRows = useMemo(() => {
    const filtered = baseRows.filter((row) => Object.entries(columnFilters).every(([key, selected]) => {
      if (!selected.length) return false
      const column = columns.find((item) => item.key === key)
      return !column || selected.includes(column.value(row))
    }))
    if (sort) {
      const column = columns.find((item) => item.key === sort.key)
      if (column) filtered.sort((a, b) => compareValues(column.sort(a), column.sort(b)) * (sort.direction === "asc" ? 1 : -1))
    }
    return filtered
  }, [baseRows, columnFilters, columns, sort])

  const agentOptions = view === "worktrees" ? ["Codex", "Git"] : ["Codex", "OpenCode", "Inconnu"]
  const total = data[view].length
  const isLoading = !snapshot || Boolean(snapshot.loading)
  const statValues = view === "servers"
    ? [
      { label: "PORTS DÉTECTÉS", value: snapshot?.servers.length ?? "—", detail: "Processus en écoute", icon: Network, tone: "cyan" },
      { label: "CLIENTS ACTIFS", value: snapshot ? snapshot.servers.reduce((sum, row) => sum + row.connections, 0) : "—", detail: "Connexions observées", icon: Activity, tone: "violet" },
      { label: "MÉMOIRE SERVEURS", value: snapshot ? `${(snapshot.servers.reduce((sum, row) => sum + row.memory, 0) / 1073741824).toFixed(1)} Go` : "—", detail: "Mémoire résidente", icon: Cpu, tone: "blue" },
    ]
    : view === "containers"
      ? [
        { label: "CONTENEURS ACTIFS", value: snapshot?.containers.filter((row) => row.state === "running").length ?? "—", detail: "En cours d’exécution", icon: Box, tone: "cyan" },
        { label: "CONTENEURS ARRÊTÉS", value: snapshot?.containers.filter((row) => row.state !== "running").length ?? "—", detail: "Conservés dans Docker", icon: HardDrive, tone: "violet" },
        { label: "PORTS PUBLIÉS", value: snapshot ? snapshot.containers.reduce((sum, row) => sum + row.ports.length, 0) : "—", detail: "Routés vers l’hôte", icon: Network, tone: "blue" },
      ]
      : [
        { label: "WORKTREES", value: snapshot?.worktrees.length ?? "—", detail: "Copies Git détectées", icon: FolderGit2, tone: "cyan" },
        { label: "AVEC SERVEUR", value: snapshot?.worktrees.filter((row) => row.servers > 0).length ?? "—", detail: "Au moins un port actif", icon: Activity, tone: "violet" },
        { label: "DOSSIERS ABSENTS", value: snapshot?.worktrees.filter((row) => !row.exists).length ?? "—", detail: "À nettoyer si besoin", icon: GitBranch, tone: "blue" },
      ]

  const visibleOptions = useMemo(() => agentOptions, [view])

  function toggleValue(key: string, value: string, checked: boolean, options: { key: string }[]) {
    const selected = new Set(columnFilters[key] ?? options.map((option) => option.key))
    if (checked) selected.add(value)
    else selected.delete(value)
    const next = { ...columnFilters }
    if (selected.size === options.length) delete next[key]
    else next[key] = [...selected]
    onColumnFilters(next)
  }

  function renderRow(row: ResourceRow, index: number) {
    if (view === "servers") {
      const server = row as ServerRow
      return (
        <TableRow key={`${server.pid}:${server.port}:${index}`} className="inventory-row">
          <TableCell>{columns[0].render(row)}</TableCell>
          <TableCell>{columns[1].render(row)}</TableCell>
          <TableCell>{columns[2].render(row)}</TableCell>
          <TableCell>{columns[3].render(row)}</TableCell>
          <TableCell>{columns[4].render(row)}</TableCell>
          <TableCell className="action-cell">
            <div className="row-actions">
              <Button variant="ghost" size="sm" onClick={() => onDetail(row)}>Détails</Button>
              {server.stoppable ? <Button variant="destructive" size="sm" onClick={() => onStop({ kind: "process", pid: server.pid, started: server.started, name: server.name, port: server.port })}>Arrêter</Button> : <span className="protected-label"><ShieldCheck aria-hidden="true" />Protégé</span>}
            </div>
          </TableCell>
        </TableRow>
      )
    }
    if (view === "containers") {
      const container = row as ContainerRow
      return (
        <TableRow key={container.id} className="inventory-row">
          <TableCell>{columns[0].render(row)}</TableCell>
          <TableCell>{columns[1].render(row)}</TableCell>
          <TableCell>{columns[2].render(row)}</TableCell>
          <TableCell>{columns[3].render(row)}</TableCell>
          <TableCell className="action-cell">
            <div className="row-actions">
              <Button variant="ghost" size="sm" onClick={() => onDetail(row)}>Détails</Button>
              {container.stoppable ? <Button variant="destructive" size="sm" onClick={() => onStop({ kind: "container", id: container.id, started: container.started, name: container.name })}>Arrêter</Button> : <span className="protected-label"><ShieldCheck aria-hidden="true" />{container.state === "running" ? "Protégé" : "Arrêté"}</span>}
            </div>
          </TableCell>
        </TableRow>
      )
    }
    return (
      <TableRow key={(row as WorktreeRow).path} className="inventory-row">
        {columns.map((column) => <TableCell key={column.key}>{column.render(row)}</TableCell>)}
      </TableRow>
    )
  }

  return (
    <>
      <section className="page-hero">
        <div className="hero-copy">
          <div className="hero-overline"><span className="overline-mark" />SYSTÈME LOCAL <span>/</span> CARTOGRAPHIE EN DIRECT</div>
          <h1>{title.title}<span className="title-cursor">_</span></h1>
          <p>{title.intro}</p>
        </div>
        <div className="hero-aside"><span className="hero-orbit"><Activity aria-hidden="true" /></span><div><span>RÉSEAU</span><strong>127.0.0.1</strong><small>BOUCLE LOCALE · PROTÉGÉE</small></div></div>
      </section>

      <section className="stats-grid" aria-label="Résumé de l’inventaire">
        {statValues.map(({ label, value, detail, icon: Icon, tone }, index) => (
          <Card key={label} className={`stat-card stat-${tone}`}>
            <CardHeader className="stat-header">
              <CardDescription>{label}</CardDescription>
              <span className="stat-icon"><Icon aria-hidden="true" /></span>
            </CardHeader>
            <CardContent className="stat-content">
              <CardTitle className="stat-value">{isLoading ? <Skeleton className="stat-skeleton" /> : value}</CardTitle>
              <span className="stat-detail"><span className="stat-led" />{detail}</span>
            </CardContent>
            <span className="stat-index">0{index + 1}</span>
          </Card>
        ))}
      </section>

      <Card className="inventory-card">
        <CardHeader className="inventory-header">
          <div className="inventory-heading-copy">
            <div className="section-kicker"><span className="section-kicker-line" />INVENTAIRE // {view === "servers" ? "TCP · UDP" : view === "containers" ? "DOCKER ENGINE" : "GIT WORKTREES"}</div>
            <CardTitle className="inventory-title">{title.list}</CardTitle>
            <CardDescription className="inventory-caption">{snapshot ? `${visibleRows.length} affiché${visibleRows.length !== 1 ? "s" : ""} sur ${total} détecté${total !== 1 ? "s" : ""}` : "Lecture du système en cours"}</CardDescription>
          </div>
          <Badge variant="outline" className={`inventory-state ${connection === "stale" ? "status-idle" : "status-ready"}`}><span className={connection === "stale" ? "status-dot status-dot-muted" : "status-dot"} />{snapshot?.loading ? "Premier scan" : connection === "stale" ? "Données anciennes" : "Surveillance active"}</Badge>
        </CardHeader>

        {snapshot?.warnings?.length ? <div className="warning-stack">{snapshot.warnings.map((warning, index) => <Alert key={`${warning}:${index}`} variant="default" className="warning-alert"><ShieldAlert aria-hidden="true" /><div><AlertTitle>Signal du collecteur</AlertTitle><AlertDescription>{warning}</AlertDescription></div></Alert>)}</div> : null}

        <FieldGroup className="toolbar-fields">
          <Field orientation="horizontal" className="search-field">
            <FieldLabel htmlFor={`inventory-search-${view}`} className="sr-only">Rechercher dans l’inventaire</FieldLabel>
            <div className="search-wrap"><Search aria-hidden="true" /><Input id={`inventory-search-${view}`} value={search} onChange={(event) => onSearch(event.target.value)} type="search" placeholder="Rechercher un port, projet, PID…" /></div>
          </Field>
          {view !== "containers" ? (
            <Field orientation="horizontal" className="filter-control">
              <FieldLabel htmlFor={`agent-filter-${view}`} className="filter-caption">{title.filter}</FieldLabel>
              <Select value={agent} onValueChange={onAgent}>
                <SelectTrigger id={`agent-filter-${view}`} className="agent-select"><SelectValue placeholder="Toutes" /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">Toutes</SelectItem>
                    {visibleOptions.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {view === "servers" ? (
            <Field orientation="horizontal" className="system-filter"><FieldLabel htmlFor="include-system">Services système</FieldLabel><Switch id="include-system" checked={includeSystem} onCheckedChange={onIncludeSystem} /></Field>
          ) : null}
        </FieldGroup>

        <div className="table-host">
          <Table className="inventory-table">
            <TableHeader>
              <TableRow className="table-head-row">
                {columns.map((column) => {
                  const options = [...new Map(baseRows.map((row) => [column.value(row), { key: column.value(row), label: column.value(row) }])).values()].sort((a, b) => a.label.localeCompare(b.label, "fr", { numeric: true, sensitivity: "base" }))
                  const selected = columnFilters[column.key]
                  return (
                    <TableHead key={column.key}>
                      <div className="table-heading">
                        <span>{column.label}</span>
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button variant="ghost" size="icon-xs" aria-label={`Options de ${column.label}`} className="column-menu-button"><SlidersHorizontal aria-hidden="true" /></Button>
                          </PopoverTrigger>
                          <PopoverContent align="end" className="column-popover">
                            <div className="popover-title"><strong>{column.label}</strong><span>{options.length} valeurs</span></div>
                            <div className="sort-actions">
                              <Button variant="outline" size="sm" aria-pressed={sort?.key === column.key && sort.direction === "asc"} onClick={() => onSort({ key: column.key, direction: "asc" })}><ArrowUp data-icon="inline-start" aria-hidden="true" />Croissant</Button>
                              <Button variant="outline" size="sm" aria-pressed={sort?.key === column.key && sort.direction === "desc"} onClick={() => onSort({ key: column.key, direction: "desc" })}><ArrowDown data-icon="inline-start" aria-hidden="true" />Décroissant</Button>
                              <Button variant="ghost" size="sm" onClick={() => onSort(null)}>Effacer le tri</Button>
                            </div>
                            <Separator />
                            <div className="filter-actions"><span>Filtrer les valeurs</span><div><Button variant="link" size="sm" onClick={() => { const next = { ...columnFilters }; delete next[column.key]; onColumnFilters(next) }}>Tout</Button><Button variant="link" size="sm" onClick={() => onColumnFilters({ ...columnFilters, [column.key]: [] })}>Aucun</Button></div></div>
                            <ScrollArea className="filter-options">
                              {options.length ? options.map((option, index) => {
                                const id = `filter-${view}-${column.key}-${index}`
                                return <Field key={option.key} orientation="horizontal" className="filter-option"><Checkbox id={id} checked={!selected || selected.includes(option.key)} onCheckedChange={(checked) => toggleValue(column.key, option.key, checked === true, options)} /><FieldLabel htmlFor={id} className="filter-option-label">{option.label || "Valeur vide"}</FieldLabel><small>{baseRows.filter((row) => column.value(row) === option.key).length}</small></Field>
                              }) : <span className="filter-empty">Aucune valeur à filtrer.</span>}
                            </ScrollArea>
                          </PopoverContent>
                        </Popover>
                      </div>
                    </TableHead>
                  )
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map(renderRow)}
            </TableBody>
          </Table>

          {!visibleRows.length ? (
            <div className="empty-state">
              <span className="empty-icon">{isLoading ? <LoaderCircle className="spin" aria-hidden="true" /> : <Search aria-hidden="true" />}</span>
              <strong>{isLoading ? "Premier inventaire en cours" : search ? "Aucun résultat pour cette recherche" : connection === "stale" ? "Collecteur indisponible" : view === "servers" ? "Aucun serveur de développement identifié" : view === "containers" ? "Aucun conteneur détecté" : "Aucun worktree trouvé"}</strong>
              <span>{isLoading ? "Le collecteur Windows rassemble les informations du PC." : connection === "stale" ? "Relancez Start-Localdeck.ps1 sur Windows, puis actualisez." : search ? "Essayez un autre port, PID ou nom de projet." : view === "servers" ? "Activez Services système pour voir tous les ports." : view === "containers" ? "Vérifiez que Docker Desktop est démarré." : "Les racines configurées sont analysées par le collecteur."}</span>
            </div>
          ) : null}
        </div>

        <div className="inventory-footer"><span><Clock3 aria-hidden="true" />{snapshot?.timestamp ? `Dernier scan à ${new Date(snapshot.timestamp * 1000).toLocaleTimeString("fr-FR")}` : "En attente du premier scan"}{snapshot?.scan_ms != null ? ` · ${(snapshot.scan_ms / 1000).toFixed(1)} s` : ""}</span><span><span className="status-dot" />Actualisation automatique · 8 s</span></div>
      </Card>

      <p className="view-note">{view === "servers" ? "L’origine repose sur les processus parents retrouvés. Les connexions sont un instantané du scan, un serveur sans client visible peut rester utile." : view === "containers" ? "Arrêter un conteneur conserve ses volumes. Localdeck et les services partagés protégés ne peuvent pas être arrêtés ici." : "Git recense tous les worktrees des dépôts trouvés, même sans serveur actif."}</p>
    </>
  )
}

function compareValues(a: string | number, b: string | number) {
  if (a === b) return 0
  if (typeof a === "number" && typeof b === "number") return a - b
  return String(a).localeCompare(String(b), "fr", { numeric: true, sensitivity: "base" })
}

function DetailSheet({ detail, onOpenChange }: { detail: DetailTarget; onOpenChange: (open: boolean) => void }) {
  if (!detail || detail.view === "worktrees") return <Sheet open={false} onOpenChange={onOpenChange}><SheetContent side="right"><SheetHeader><SheetTitle>Détails</SheetTitle><SheetDescription>Ressource locale</SheetDescription></SheetHeader></SheetContent></Sheet>
  const isContainer = detail.view === "containers"
  const title = isContainer ? (detail.row as ContainerRow).name : `${(detail.row as ServerRow).name} · :${(detail.row as ServerRow).port}`
  return (
    <Sheet open={Boolean(detail)} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="detail-sheet">
        <SheetHeader className="detail-header">
          <div className="detail-kicker"><span className="overline-mark" />FICHE RESSOURCE</div>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{isContainer ? "Informations du conteneur Docker sélectionné." : "Processus à l’écoute et activité réseau locale."}</SheetDescription>
        </SheetHeader>
        {isContainer ? <ContainerDetails row={detail.row as ContainerRow} /> : <ServerDetails row={detail.row as ServerRow} />}
      </SheetContent>
    </Sheet>
  )
}

function ContainerDetails({ row }: { row: ContainerRow }) {
  return <div className="detail-body">
    <div className="detail-status-row"><StateBadge state={row.state} />{row.health ? <Badge variant="secondary">{row.health}</Badge> : null}</div>
    <dl className="detail-grid">
      <DetailItem label="Image" value={row.image} />
      <DetailItem label="Conteneur" value={row.id} mono />
      <DetailItem label="Projet" value={row.project || "Inconnu"} />
      <DetailItem label="Service" value={row.service || "Inconnu"} />
      <DetailItem label="Dossier" value={row.directory || "Label Compose absent"} mono />
      <DetailItem label="Démarré" value={row.started || "Inconnu"} />
      <DetailItem label="Ports publiés" value={containerPorts(row)} mono />
    </dl>
  </div>
}

function ServerDetails({ row }: { row: ServerRow }) {
  return <div className="detail-body">
    <div className="detail-status-row"><OriginBadge origin={row.agent} /><Badge variant="secondary">PID {row.pid}</Badge><Badge variant="outline" className={row.stoppable ? "status-ready" : "status-idle"}>{row.stoppable ? "Arrêtable" : "Protégé"}</Badge></div>
    <p className="detail-evidence">{row.evidence}</p>
    <dl className="detail-grid">
      <DetailItem label="Projet Git" value={row.repo || "Non identifié"} mono />
      <DetailItem label="Dossier réel" value={row.cwd || "Inaccessible"} mono />
      <DetailItem label="Écoute" value={`${row.bindings.join(", ")} · ${row.protocol}`} mono />
      <DetailItem label="Démarré" value={row.started ? new Date(row.started * 1000).toLocaleString("fr-FR") : "Inconnu"} />
      <DetailItem label="Utilisation" value={`${row.connections} connexion${row.connections !== 1 ? "s" : ""} · ${(row.memory / 1048576).toFixed(0)} Mo · ${row.cpu.toFixed(1)} % CPU`} />
    </dl>
    <DetailSection title="Clients connectés" icon={<Network aria-hidden="true" />}>
      {row.clients.length ? row.clients.map((client, index) => <div key={`${client.pid}:${client.endpoint}:${index}`} className="detail-row"><span>{client.name || "Inconnu"}</span><span className="mono detail-secondary">PID {client.pid} · {client.endpoint}</span></div>) : <p className="detail-empty">Aucun client local trouvé à cet instant.</p>}
    </DetailSection>
    <DetailSection title="Processus parents" icon={<GitBranch aria-hidden="true" />}>
      {row.ancestry.length ? row.ancestry.map((parent, index) => <div key={`${parent.pid}:${index}`} className="ancestor-card"><div className="ancestor-title"><strong>{parent.name}</strong><Badge variant="outline">PID {parent.pid}</Badge></div><span className="mono detail-secondary">{parent.cwd || "Dossier inaccessible"}</span><pre>{parent.command || "Commande inaccessible"}</pre></div>) : <p className="detail-empty">Aucun processus parent disponible.</p>}
    </DetailSection>
  </div>
}

function DetailItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="detail-item"><dt>{label}</dt><dd className={mono ? "mono" : ""}>{value}</dd></div>
}

function DetailSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <section className="detail-section"><h3>{icon}{title}</h3>{children}</section>
}

export default App
