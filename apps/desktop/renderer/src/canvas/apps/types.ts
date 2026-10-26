export type AppState = Record<string, unknown>
export type AppPlacement = { mode:'float'|'screen'|'popout'|'canvas'; x:number; y:number; width:number; height:number; anchor?:string|null }
export interface AppEventDeclaration { name:string; description?:string }
export interface AppDefinition { name:string; description:string; html:string; initial_state:AppState; capabilities:string[]; events?:AppEventDeclaration[]; width:number; height:number }
export interface CustomApp { id:string; name:string; description:string; capabilities:string[]; events?:AppEventDeclaration[]; width:number; height:number; rev:number; permission_rev?:number; is_new?:boolean; permissions:Record<string,string>; created_by:string; updated_at:string; definition?:AppDefinition }
export interface CustomPanel { id:string; app:string; label:string; rev:number; open:boolean; placement:AppPlacement; linked_agents:string[]; updated_at:string; used_at:string; state?:AppState; event_seq?:number }
export interface AppPage<T> { kind:string; items:T[]; next_cursor:string|null; new_count?:number }
export interface PanelEvent {seq:number;name:string;payload:unknown;actor:string;at:string}
export interface PanelEvents {panel:string;events:PanelEvent[];next_cursor:number|null;oldest_retained:number|null}
