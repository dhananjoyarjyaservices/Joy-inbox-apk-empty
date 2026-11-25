import { useState, type ReactNode, type DragEvent } from "react";
import { ArrowDown, ArrowUp, GitBranch, MessageSquareText, Play, Clock3, GripVertical } from "lucide-react";

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
  onMoveBranch: (from: number, to: number) => void;
  onMoveDefaultStep: (from: number, to: number) => void;
  onMoveBranchStep: (branchIndex: number, from: number, to: number) => void;\n  onMoveTriggerCondition: (from: number, to: number) => void;\n  onMoveBranchCondition: (branchIndex: number, from: number, to: number) => void;
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
  const [dragging, setDragging] = useState<{kind:"branch"|"step"|"condition";branchIndex:number;index:number}|null>(null);
  const allowDrop = (event: DragEvent) => event.preventDefault();
  const startDrag = (event: DragEvent, item: {kind:"branch"|"step"|"condition";branchIndex:number;index:number}) => { setDragging(item); event.dataTransfer.effectAllowed="move"; event.dataTransfer.setData("text/plain", item.kind+":"+item.branchIndex+":"+item.index); };
  const finishDrag = () => setDragging(null);
  const paths = props.branches.length ? props.branches.map(branch => ({ name: branch.name || "Unnamed branch", mode: branch.conditionMode, conditions: branch.conditions, steps: branch.steps })) : [{ name: "Default path", mode: props.conditionMode, conditions: props.conditions, steps: props.steps }];
  return <section aria-label="Automation flow preview" className="mb-5 rounded-xl border border-[#cfe5df] bg-[#f5fbf9] p-4">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold text-gray-900">Workflow preview</h3><p className="text-[11px] text-gray-500">Live diagram · updates as you edit the rule below</p></div><span className="rounded-full bg-white px-2 py-1 text-[10px] font-medium text-[#075e54]">Preview only</span></div>
    <div className="mx-auto max-w-md">
      <Node icon={<Play size={15}/>} title="Incoming WhatsApp message" subtitle={props.name.trim() || "New automation rule"}/>
      <Connector/>
      <Node icon={<MessageSquareText size={15}/>} title="Trigger conditions" subtitle={props.conditionMode.toUpperCase() + " · " + props.conditions.length + " condition(s)"}>
        {props.conditions.map((condition, index) => <div key={index} draggable onDragStart={event=>startDrag(event,{kind:"condition",branchIndex:-1,index})} onDragOver={allowDrop} onDrop={event=>{event.preventDefault();event.stopPropagation();if(dragging?.kind==="condition"&&dragging.branchIndex===-1)props.onMoveTriggerCondition(dragging.index,index);finishDrag();}} onDragEnd={finishDrag} className="flex items-center justify-between gap-2 rounded-md bg-gray-50 px-2 py-1"><span className="flex min-w-0 items-center gap-1 break-words text-[11px] text-gray-600"><GripVertical size={12}/>{matchLabel[condition.matchType] || condition.matchType} “{condition.keyword || "keyword not set"}”</span><span className="flex shrink-0"><button type="button" aria-label={"Move trigger condition "+(index+1)+" up"} disabled={index===0} onClick={()=>props.onMoveTriggerCondition(index,index-1)} className="rounded p-1 text-gray-500 disabled:opacity-25"><ArrowUp size={12}/></button><button type="button" aria-label={"Move trigger condition "+(index+1)+" down"} disabled={index===props.conditions.length-1} onClick={()=>props.onMoveTriggerCondition(index,index+1)} className="rounded p-1 text-gray-500 disabled:opacity-25"><ArrowDown size={12}/></button></span></div>)}
      </Node>
      {props.scheduleEnabled && <><Connector/><Node icon={<Clock3 size={15}/>} title="Business-hours schedule" subtitle={props.scheduleTimezone}><p className="text-[11px] text-gray-600">{props.scheduleDays.map(day => dayNames[day]).join(", ") || "No days selected"} · {props.scheduleStart}–{props.scheduleEnd}</p></Node></>}
    </div>
    <div className="my-3 flex items-center justify-center gap-2 text-[11px] font-medium text-gray-500"><GitBranch size={14}/> {props.branches.length ? "First matching branch runs" : "Default reply sequence"}</div>
    <div className={paths.length > 1 ? "grid gap-3 md:grid-cols-2" : "mx-auto max-w-md"}>
      {paths.map((path, index) => <div key={index} onDragOver={allowDrop} onDrop={event=>{event.preventDefault();if(dragging?.kind==="branch"&&props.branches.length)props.onMoveBranch(dragging.index,index);finishDrag();}} onDragEnd={finishDrag} className={"min-w-0 rounded-xl border border-dashed border-gray-300 bg-white/70 p-3 "+(dragging?.kind==="branch"&&dragging.index===index?"opacity-50":"")}>
        <div className="mb-2 flex items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-1">{props.branches.length>0&&<button type="button" draggable onDragStart={event=>startDrag(event,{kind:"branch",branchIndex:index,index})} onDragEnd={finishDrag} aria-label={"Drag to reorder "+path.name} className="cursor-grab touch-none rounded p-1 text-gray-400"><GripVertical size={15}/></button>}<span className="truncate text-xs font-semibold text-[#075e54]">{path.name}</span></div><div className="flex items-center gap-1">{props.branches.length>0&&<><button type="button" aria-label={"Move "+path.name+" up"} disabled={index===0} onClick={()=>props.onMoveBranch(index,index-1)} className="rounded p-1 text-gray-500 disabled:opacity-25"><ArrowUp size={13}/></button><button type="button" aria-label={"Move "+path.name+" down"} disabled={index===paths.length-1} onClick={()=>props.onMoveBranch(index,index+1)} className="rounded p-1 text-gray-500 disabled:opacity-25"><ArrowDown size={13}/></button></>}<span className="text-[10px] text-gray-400">{path.mode.toUpperCase()}</span></div></div>
        {path.conditions.map((condition, conditionIndex) => <div key={conditionIndex} draggable onDragStart={event=>startDrag(event,{kind:"condition",branchIndex:props.branches.length?index:-1,index:conditionIndex})} onDragOver={allowDrop} onDrop={event=>{event.preventDefault();event.stopPropagation();if(dragging?.kind==="condition"){if(dragging.branchIndex===-1)props.onMoveTriggerCondition(dragging.index,conditionIndex);else if(dragging.branchIndex===index)props.onMoveBranchCondition(index,dragging.index,conditionIndex);}finishDrag();}} onDragEnd={finishDrag} className="mb-1 flex items-center justify-between gap-2 rounded-md bg-gray-50 px-2 py-1"><span className="flex min-w-0 items-center gap-1 break-words text-[10px] text-gray-600"><GripVertical size={11}/>{matchLabel[condition.matchType] || condition.matchType} “{condition.keyword || "keyword not set"}”</span><span className="flex shrink-0"><button type="button" aria-label={"Move condition "+(conditionIndex+1)+" up"} disabled={conditionIndex===0} onClick={()=>props.branches.length?props.onMoveBranchCondition(index,conditionIndex,conditionIndex-1):props.onMoveTriggerCondition(conditionIndex,conditionIndex-1)} className="rounded p-1 text-gray-500 disabled:opacity-25"><ArrowUp size={11}/></button><button type="button" aria-label={"Move condition "+(conditionIndex+1)+" down"} disabled={conditionIndex===path.conditions.length-1} onClick={()=>props.branches.length?props.onMoveBranchCondition(index,conditionIndex,conditionIndex+1):props.onMoveTriggerCondition(conditionIndex,conditionIndex+1)} className="rounded p-1 text-gray-500 disabled:opacity-25"><ArrowDown size={11}/></button></span></div>)}
        <Connector/>
        {path.steps.map((step, stepIndex) => <div key={stepIndex} draggable onDragStart={event=>{event.stopPropagation();startDrag(event,{kind:"step",branchIndex:props.branches.length?index:-1,index:stepIndex});}} onDragOver={allowDrop} onDrop={event=>{event.preventDefault();event.stopPropagation();if(dragging?.kind==="step"){if(dragging.branchIndex===-1)props.onMoveDefaultStep(dragging.index,stepIndex);else if(dragging.branchIndex===index)props.onMoveBranchStep(index,dragging.index,stepIndex);}finishDrag();}} onDragEnd={finishDrag} className={"mb-2 last:mb-0 cursor-grab rounded-lg active:cursor-grabbing "+(dragging?.kind==="step"&&dragging.branchIndex===(props.branches.length?index:-1)&&dragging.index===stepIndex?"opacity-40":"")}><div className="flex items-center justify-between px-1 pb-1"><span className="flex items-center gap-1 text-[10px] text-gray-400"><GripVertical size={12}/> Drag reply to reorder</span><span className="flex gap-1"><button type="button" aria-label={"Move reply "+(stepIndex+1)+" up"} disabled={stepIndex===0} onClick={()=>props.branches.length?props.onMoveBranchStep(index,stepIndex,stepIndex-1):props.onMoveDefaultStep(stepIndex,stepIndex-1)} className="rounded p-1 text-gray-500 disabled:opacity-25"><ArrowUp size={12}/></button><button type="button" aria-label={"Move reply "+(stepIndex+1)+" down"} disabled={stepIndex===path.steps.length-1} onClick={()=>props.branches.length?props.onMoveBranchStep(index,stepIndex,stepIndex+1):props.onMoveDefaultStep(stepIndex,stepIndex+1)} className="rounded p-1 text-gray-500 disabled:opacity-25"><ArrowDown size={12}/></button></span></div><Node icon={<MessageSquareText size={14}/>} title={"Send reply " + (stepIndex + 1)} subtitle={step.delaySeconds > 0 ? "Wait " + step.delaySeconds + " seconds first" : "Immediate"}><p className="break-words text-[11px] text-gray-600">{step.message || "Reply text not set"}</p></Node>{stepIndex < path.steps.length - 1 && <Connector/>}</div>)}
        {path.steps.length === 0 && <p className="text-[11px] text-gray-400">No reply steps configured</p>}
      </div>)}
      {props.branches.length > 0 && <div className="rounded-xl border border-dashed border-gray-300 bg-white/70 p-3 md:col-span-2"><p className="text-xs font-semibold text-gray-600">Fallback · default reply sequence</p><div className="mt-2 grid gap-2 sm:grid-cols-2">{props.steps.map((step, index) => <div key={index} draggable onDragStart={event=>startDrag(event,{kind:"step",branchIndex:-1,index})} onDragOver={allowDrop} onDrop={event=>{event.preventDefault();event.stopPropagation();if(dragging?.kind==="step"&&dragging.branchIndex===-1)props.onMoveDefaultStep(dragging.index,index);finishDrag();}} onDragEnd={finishDrag} className="rounded-lg border border-gray-100 bg-white p-2"><div className="mb-1 flex items-center justify-between"><span className="flex items-center gap-1 text-[10px] text-gray-400"><GripVertical size={12}/> Fallback reply {index+1}</span><span className="flex gap-1"><button type="button" aria-label={"Move fallback reply "+(index+1)+" up"} disabled={index===0} onClick={()=>props.onMoveDefaultStep(index,index-1)} className="rounded p-1 text-gray-500 disabled:opacity-25"><ArrowUp size={12}/></button><button type="button" aria-label={"Move fallback reply "+(index+1)+" down"} disabled={index===props.steps.length-1} onClick={()=>props.onMoveDefaultStep(index,index+1)} className="rounded p-1 text-gray-500 disabled:opacity-25"><ArrowDown size={12}/></button></span></div><Node icon={<MessageSquareText size={14}/>} title={"Reply " + (index + 1)} subtitle={step.delaySeconds > 0 ? "Wait " + step.delaySeconds + " seconds" : "Immediate"}><p className="break-words text-[11px] text-gray-600">{step.message || "Reply text not set"}</p></Node></div>)}</div></div>}
    </div>
    <p className="mt-3 text-[10px] text-gray-400">Drag branch and reply handles to reorder execution. Arrow controls also work on touch screens. Free-position node placement and custom connector editing are not supported yet.</p>
  </section>;
}
