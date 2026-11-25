import type { ReactNode } from "react";
import { ArrowDown, GitBranch, MessageSquareText, Play, Clock3 } from "lucide-react";

type Condition = { keyword: string; matchType: string };
type ReplyStep = { message: string; delaySeconds: number };
type Branch = { name: string; conditionMode: "all" | "any"; conditions: Condition[]; steps: ReplyStep[] };

interface AutomationFlowPreviewProps {
  name: string;
  conditions: Condition[];
  conditionMode: "all" | "any";
  steps: ReplyStep[];
  branches: Branch[];
  scheduleEnabled: boolean;
  scheduleTimezone: string;
  scheduleDays: number[];
  scheduleStart: string;
  scheduleEnd: string;
}

const matchLabel: Record<string, string> = {
  contains: "contains", exact: "exactly matches", starts_with: "starts with",
  ends_with: "ends with", not_contains: "does not contain", not_exact: "does not exactly match"
};

function Node({ icon, title, subtitle, children }: { icon: ReactNode; title: string; subtitle?: string; children?: ReactNode }) {
  return <div className="min-w-0 rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
    <div className="flex items-center gap-2"><span className="rounded-lg bg-[#e6f4f1] p-2 text-[#075e54]">{icon}</span><div className="min-w-0"><p className="text-xs font-semibold text-gray-800">{title}</p>{subtitle && <p className="text-[10px] text-gray-500">{subtitle}</p>}</div></div>
    {children && <div className="mt-2 space-y-1">{children}</div>}
  </div>;
}

function Connector() {
  return <div className="flex h-7 items-center justify-center text-gray-400"><ArrowDown size={15}/></div>;
}

export default function AutomationFlowPreview(props: AutomationFlowPreviewProps) {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const paths = props.branches.length ? props.branches.map(branch => ({ name: branch.name || "Unnamed branch", mode: branch.conditionMode, conditions: branch.conditions, steps: branch.steps })) : [{ name: "Default path", mode: props.conditionMode, conditions: props.conditions, steps: props.steps }];
  return <section aria-label="Automation flow preview" className="mb-5 rounded-xl border border-[#cfe5df] bg-[#f5fbf9] p-4">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold text-gray-900">Workflow preview</h3><p className="text-[11px] text-gray-500">Live diagram · updates as you edit the rule below</p></div><span className="rounded-full bg-white px-2 py-1 text-[10px] font-medium text-[#075e54]">Preview only</span></div>
    <div className="mx-auto max-w-md">
      <Node icon={<Play size={15}/>} title="Incoming WhatsApp message" subtitle={props.name.trim() || "New automation rule"}/>
      <Connector/>
      <Node icon={<MessageSquareText size={15}/>} title="Trigger conditions" subtitle={props.conditionMode.toUpperCase() + " · " + props.conditions.length + " condition(s)"}>
        {props.conditions.map((condition, index) => <p key={index} className="break-words text-[11px] text-gray-600">{matchLabel[condition.matchType] || condition.matchType} “{condition.keyword || "keyword not set"}”</p>)}
      </Node>
      {props.scheduleEnabled && <><Connector/><Node icon={<Clock3 size={15}/>} title="Business-hours schedule" subtitle={props.scheduleTimezone}><p className="text-[11px] text-gray-600">{props.scheduleDays.map(day => dayNames[day]).join(", ") || "No days selected"} · {props.scheduleStart}–{props.scheduleEnd}</p></Node></>}
    </div>
    <div className="my-3 flex items-center justify-center gap-2 text-[11px] font-medium text-gray-500"><GitBranch size={14}/> {props.branches.length ? "First matching branch runs" : "Default reply sequence"}</div>
    <div className={paths.length > 1 ? "grid gap-3 md:grid-cols-2" : "mx-auto max-w-md"}>
      {paths.map((path, index) => <div key={index} className="min-w-0 rounded-xl border border-dashed border-gray-300 bg-white/70 p-3">
        <div className="mb-2 flex items-center justify-between gap-2"><span className="text-xs font-semibold text-[#075e54]">{path.name}</span><span className="text-[10px] text-gray-400">{path.mode.toUpperCase()}</span></div>
        {path.conditions.map((condition, conditionIndex) => <p key={conditionIndex} className="mb-1 break-words rounded-md bg-gray-50 px-2 py-1 text-[10px] text-gray-600">{matchLabel[condition.matchType] || condition.matchType} “{condition.keyword || "keyword not set"}”</p>)}
        <Connector/>
        {path.steps.map((step, stepIndex) => <div key={stepIndex} className="mb-2 last:mb-0"><Node icon={<MessageSquareText size={14}/>} title={"Send reply " + (stepIndex + 1)} subtitle={step.delaySeconds > 0 ? "Wait " + step.delaySeconds + " seconds first" : "Immediate"}><p className="break-words text-[11px] text-gray-600">{step.message || "Reply text not set"}</p></Node>{stepIndex < path.steps.length - 1 && <Connector/>}</div>)}
        {path.steps.length === 0 && <p className="text-[11px] text-gray-400">No reply steps configured</p>}
      </div>)}
      {props.branches.length > 0 && <div className="rounded-xl border border-dashed border-gray-300 bg-white/70 p-3 md:col-span-2"><p className="text-xs font-semibold text-gray-600">Fallback · default reply sequence</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{props.steps.map((step, index) => <Node key={index} icon={<MessageSquareText size={14}/>} title={"Reply " + (index + 1)} subtitle={step.delaySeconds > 0 ? "Wait " + step.delaySeconds + " seconds" : "Immediate"}><p className="break-words text-[11px] text-gray-600">{step.message || "Reply text not set"}</p></Node>)}</div></div>}
    </div>
    <p className="mt-3 text-[10px] text-gray-400">This diagram is a synchronized preview. Drag-and-drop editing and movable workflow nodes are not implemented yet.</p>
  </section>;
}
