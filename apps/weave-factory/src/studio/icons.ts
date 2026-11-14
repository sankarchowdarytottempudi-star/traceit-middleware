// Catalog icon names -> lucide components. A curated map keeps the bundle small (importing
// every lucide icon would add several hundred KB); unknown names fall back to a plug.
import {
  Bell, Blocks, Box, Braces, Cable, Calendar, Clock, Cloud, Code, CornerDownLeft, Cpu, CreditCard, Database, FileCode, FileJson,
  FileText, Filter, FunctionSquare, GitBranch, Globe, HardDrive, Key, Layers, Link, ListChecks, Lock, Mail, MessageSquare, Network,
  OctagonX, Package, Play, Plug, Puzzle, Repeat, Rss, ScrollText, Search, Send, Server, ShieldAlert, ShoppingCart, Shuffle, Split,
  StickyNote, Table, Terminal, Timer, Users, Variable, Webhook, Workflow, Zap, type LucideIcon,
} from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  Bell, Blocks, Box, Braces, Cable, Calendar, Clock, Cloud, Code, CornerDownLeft, Cpu, CreditCard, Database, FileCode, FileJson,
  FileText, Filter, FunctionSquare, SquareFunction: FunctionSquare, GitBranch, Globe, HardDrive, Key, Layers, Link, ListChecks, Lock,
  Mail, MessageSquare, Network, OctagonX, Package, Play, Plug, Puzzle, Repeat, Rss, ScrollText, Search, Send, Server, ShieldAlert,
  ShoppingCart, Shuffle, Split, StickyNote, Table, Terminal, Timer, Users, Variable, Webhook, Workflow, Zap,
};
export function iconFor(name: string | undefined): LucideIcon {
  return (name && MAP[name]) || Plug;
}
