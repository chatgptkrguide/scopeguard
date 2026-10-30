// Sample project used until the store and PayPal sandbox are wired in.
// Harbor & Pine Coffee is a fictional client.

export interface ScopeLine {
  id: string;
  title: string;
  amount: number;
}

export type ChangeOrderStatus = "draft" | "sent" | "paid" | "waived";

export interface ChangeOrder {
  id: string;
  title: string;
  amount: number;
  extraDays: number;
  status: ChangeOrderStatus;
  paidOn?: string;
}

// A phrase in a client message that adds work beyond the agreed scope.
export interface ScopeFlag {
  quote: string; // exact substring of the message body
  changeOrderId: string;
  reason: string;
}

export interface Message {
  id: string;
  from: "client" | "me";
  author: string;
  sentOn: string;
  body: string;
  flags?: ScopeFlag[];
}

export interface Project {
  client: string;
  title: string;
  agreedOn: string;
  scope: ScopeLine[];
  changeOrders: ChangeOrder[];
  messages: Message[];
}

export const sampleProject: Project = {
  client: "Harbor & Pine Coffee",
  title: "Online ordering site",
  agreedOn: "Oct 21",
  scope: [
    { id: "s1", title: "Landing page", amount: 900 },
    { id: "s2", title: "Menu with online ordering", amount: 1200 },
    { id: "s3", title: "Contact form", amount: 300 },
  ],
  changeOrders: [
    { id: "co1", title: "Gift card page", amount: 250, extraDays: 2, status: "paid", paidOn: "Oct 26" },
    { id: "co2", title: "Loyalty page with customer login", amount: 650, extraDays: 4, status: "draft" },
  ],
  messages: [
    {
      id: "m1",
      from: "client",
      author: "Maya Lindqvist",
      sentOn: "Oct 21",
      body: "Hi Junsu! Excited to get started. As we discussed: a landing page, our menu with online ordering, and a contact form. We'd love to launch by November 15.",
    },
    {
      id: "m2",
      from: "me",
      author: "You",
      sentOn: "Oct 21",
      body: "Thanks Maya. Sending the quote for those three pages now, with launch on November 15.",
    },
    {
      id: "m3",
      from: "client",
      author: "Maya Lindqvist",
      sentOn: "Oct 24",
      body: "Quick one: could we sell gift cards on the site too? Holiday season is coming.",
      flags: [
        {
          quote: "sell gift cards on the site",
          changeOrderId: "co1",
          reason: "Gift card sales need their own page and checkout flow.",
        },
      ],
    },
    {
      id: "m4",
      from: "client",
      author: "Maya Lindqvist",
      sentOn: "Oct 28",
      body: "The menu looks great so far! Could you also add a loyalty page where customers log in to see their stamps? Our investors want it at launch.",
      flags: [
        {
          quote: "add a loyalty page where customers log in to see their stamps",
          changeOrderId: "co2",
          reason:
            "Version 1 covers a landing page, the menu with ordering, and a contact form. Customer accounts aren't part of it.",
        },
      ],
    },
  ],
};

export const usd = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
