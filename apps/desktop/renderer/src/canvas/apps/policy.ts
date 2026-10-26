import type {CustomApp} from './types'
/** Default file permissions cover this org's collections only, never arbitrary paths. */
export const appCapabilities=(app:CustomApp)=>[...new Set([...app.capabilities,...Object.keys(app.default_permissions??{})])]
export const appPermission=(app:CustomApp,cap:string)=>app.permissions[cap]??app.default_permissions?.[cap]??'ask'
