"use client";

import { useState, type ReactNode } from "react";
import type { ChangeOrder, ChangeOrderStatus, Message, Project, ScopeFlag } from "@/lib/sample";
import { usd } from "@/lib/sample";

interface WorkspaceProps {
  project: Project;
}

const statusText: Record<ChangeOrderStatus, string> = {
  draft: "Waiting for your review",
  sent: "Sent to client, not paid yet",
  paid: "Paid",
  waived: "Included at no charge",
};

const statusColor: Record<ChangeOrderStatus, string> = {
  draft: "text-mark",
  sent: "text-mark",
  paid: "text-paid",
  waived: "text-ink-soft",
};

export function Workspace({ project }: WorkspaceProps) {
  const [orders, setOrders] = useState<ChangeOrder[]>(project.changeOrders);

  const setStatus = (id: string, status: ChangeOrderStatus) =>
    setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status } : o)));

  const agreed = project.scope.reduce((sum, line) => sum + line.amount, 0);
  const billable = orders.filter((o) => o.status !== "waived");
  const changes = billable.reduce((sum, o) => sum + o.amount, 0);
  const unpaid = billable.some((o) => o.status !== "paid");
  const client = project.messages.find((m) => m.from === "client")?.author ?? project.client;

  return (
    <div className="min-h-dvh">
      <header className="border-b border-rule bg-sheet">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-x-10 gap-y-4 px-4 py-5 sm:px-8">
          <div>
            <p className="text-sm font-semibold tracking-tight">Tollgate</p>
            <h1 className="mt-3 font-serif text-[28px] leading-tight">{project.client}</h1>
            <p className="text-ink-soft">{project.title}</p>
          </div>
          <dl className="flex gap-8 tabular-nums">
            <div>
              <dt className="text-sm text-ink-soft">Agreed</dt>
              <dd className="text-[22px]">{usd(agreed)}</dd>
            </div>
            <div>
              <dt className="text-sm text-ink-soft">With changes</dt>
              <dd className={`text-[22px] font-semibold ${unpaid ? "text-mark" : "text-paid"}`}>
                {usd(agreed + changes)}
              </dd>
            </div>
          </dl>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-8 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
        <section aria-labelledby="thread-title" className="rounded-md border border-rule bg-sheet">
          <h2 id="thread-title" className="sr-only">
            Conversation with {project.client}
          </h2>
          <ol>
            {project.messages.map((m) => (
              <MessageRow key={m.id} message={m} orders={orders} onStatus={setStatus} />
            ))}
          </ol>
          <Composer client={client} />
        </section>

        <ScopePanel project={project} orders={orders} agreed={agreed} changes={changes} />
      </main>
    </div>
  );
}

interface MessageRowProps {
  message: Message;
  orders: ChangeOrder[];
  onStatus: (id: string, status: ChangeOrderStatus) => void;
}

function MessageRow({ message, orders, onStatus }: MessageRowProps) {
  const flags = message.flags ?? [];
  const orderFor = (flag: ScopeFlag) => orders.find((o) => o.id === flag.changeOrderId);

  return (
    <li className="grid gap-x-8 gap-y-4 border-b border-rule px-5 py-6 last:border-b-0 sm:px-8 md:grid-cols-[minmax(0,1fr)_220px]">
      <div>
        <p className="text-sm text-ink-soft">
          <span className="font-semibold text-ink">{message.author}</span>
          <span className="ml-2">{message.sentOn}</span>
        </p>
        <p className={`mt-2 max-w-[62ch] font-serif text-[17px] leading-[1.65] ${message.from === "me" ? "text-ink-soft" : ""}`}>
          <MarkedBody message={message} orderFor={orderFor} />
        </p>
      </div>
      {flags.length > 0 && (
        <div className="space-y-6">
          {flags.map((flag) => {
            const order = orderFor(flag);
            return order ? (
              <MarginNote key={flag.changeOrderId} noteId={`note-${message.id}-${order.id}`} flag={flag} order={order} onStatus={onStatus} />
            ) : null;
          })}
        </div>
      )}
    </li>
  );
}

interface MarkedBodyProps {
  message: Message;
  orderFor: (flag: ScopeFlag) => ChangeOrder | undefined;
}

// Splits the body around each flagged quote; quotes that don't match the text are left unmarked.
function MarkedBody({ message, orderFor }: MarkedBodyProps) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  const hits = (message.flags ?? [])
    .map((flag) => ({ flag, at: message.body.indexOf(flag.quote) }))
    .filter((h) => h.at >= 0)
    .sort((a, b) => a.at - b.at);

  for (const { flag, at } of hits) {
    if (at < cursor) continue;
    const order = orderFor(flag);
    parts.push(message.body.slice(cursor, at));
    parts.push(
      <mark
        key={flag.changeOrderId}
        className="scope-mark"
        data-status={order?.status}
        data-animate={order?.status === "draft"}
        aria-describedby={order ? `note-${message.id}-${order.id}` : undefined}
      >
        {flag.quote}
      </mark>,
    );
    cursor = at + flag.quote.length;
  }
  parts.push(message.body.slice(cursor));
  return <>{parts}</>;
}

interface MarginNoteProps {
  noteId: string;
  flag: ScopeFlag;
  order: ChangeOrder;
  onStatus: (id: string, status: ChangeOrderStatus) => void;
}

function MarginNote({ noteId, flag, order, onStatus }: MarginNoteProps) {
  const open = order.status === "draft";
  const lineColor = { draft: "border-mark", sent: "border-mark", paid: "border-paid", waived: "border-rule" }[order.status];

  return (
    <aside id={noteId} className={`margin-note border-l-2 pl-4 ${lineColor}`} data-animate={open}>
      <p className={`text-sm font-semibold ${statusColor[order.status]}`}>
        {open ? "Not in the agreed scope" : statusText[order.status]}
        {order.status === "paid" && order.paidOn ? ` ${order.paidOn}` : ""}
      </p>
      <p className="mt-1 font-serif text-[17px] leading-snug">{order.title}</p>
      <p className="mt-1 tabular-nums">
        <span className="font-semibold">+{usd(order.amount)}</span>
        <span className="ml-2 text-sm text-ink-soft">about {order.extraDays} more days</span>
      </p>
      {open && (
        <>
          <p className="mt-3 text-sm leading-relaxed text-ink-soft">{flag.reason}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onStatus(order.id, "sent")}
              className="min-h-11 rounded-md bg-ink px-4 text-sm font-semibold text-sheet hover:bg-mark"
            >
              Send change order
            </button>
            <button
              type="button"
              onClick={() => onStatus(order.id, "waived")}
              className="min-h-11 rounded-md px-3 text-sm font-semibold text-ink-soft hover:text-ink"
            >
              Include at no charge
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

interface ComposerProps {
  client: string;
}

function Composer({ client }: ComposerProps) {
  return (
    <form className="border-t border-rule bg-paper/50 px-5 py-6 sm:px-8" onSubmit={(e) => e.preventDefault()}>
      <label htmlFor="incoming" className="text-sm font-semibold">
        New message from {client}
      </label>
      <textarea
        id="incoming"
        rows={3}
        placeholder="Paste their latest email or chat message"
        className="mt-2 block w-full max-w-[62ch] resize-y rounded-md border border-rule bg-sheet px-3 py-2 font-serif text-[17px] leading-relaxed placeholder:text-ink-soft/70"
      />
      <div className="mt-3 flex max-w-[62ch] flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-soft">Claude compares it with scope version 1.</p>
        <button
          type="submit"
          disabled
          className="min-h-11 rounded-md bg-ink px-4 text-sm font-semibold text-sheet disabled:cursor-not-allowed disabled:opacity-40"
        >
          Check scope
        </button>
      </div>
    </form>
  );
}

interface ScopePanelProps {
  project: Project;
  orders: ChangeOrder[];
  agreed: number;
  changes: number;
}

function ScopePanel({ project, orders, agreed, changes }: ScopePanelProps) {
  return (
    <aside aria-labelledby="scope-title" className="rounded-md border border-rule bg-sheet px-5 py-6 lg:sticky lg:top-6">
      <h2 id="scope-title" className="font-serif text-[22px]">
        Scope
      </h2>
      <p className="text-sm text-ink-soft">Version 1, agreed {project.agreedOn}</p>
      <ul className="mt-4 divide-y divide-rule border-y border-rule">
        {project.scope.map((line) => (
          <li key={line.id} className="flex justify-between gap-4 py-2.5">
            <span className="font-serif">{line.title}</span>
            <span className="tabular-nums">{usd(line.amount)}</span>
          </li>
        ))}
      </ul>

      <h3 className="mt-7 font-serif text-[18px]">Change orders</h3>
      <ul className="mt-2 divide-y divide-rule border-y border-rule">
        {orders.map((o) => (
          <li key={o.id} className="py-2.5">
            <div className="flex justify-between gap-4">
              <span className={`font-serif ${o.status === "waived" ? "text-ink-soft line-through" : ""}`}>{o.title}</span>
              <span className={`tabular-nums ${o.status === "waived" ? "text-ink-soft line-through" : ""}`}>+{usd(o.amount)}</span>
            </div>
            <p className={`text-sm ${statusColor[o.status]}`}>
              {statusText[o.status]}
              {o.status === "paid" && o.paidOn ? ` ${o.paidOn}` : ""}
            </p>
          </li>
        ))}
      </ul>

      <dl className="mt-5 space-y-1 tabular-nums">
        <div className="flex justify-between text-ink-soft">
          <dt>Agreed</dt>
          <dd>{usd(agreed)}</dd>
        </div>
        <div className="flex justify-between text-ink-soft">
          <dt>Change orders</dt>
          <dd>+{usd(changes)}</dd>
        </div>
        <div className="flex justify-between border-t border-rule pt-2 text-[18px] font-semibold">
          <dt>Total</dt>
          <dd>{usd(agreed + changes)}</dd>
        </div>
      </dl>
    </aside>
  );
}
