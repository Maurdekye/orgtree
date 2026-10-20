// canvas/username.ts — the engine's data name for the user, in one place that
// imports nothing (the canvas's derived state reads it; usermention.tsx draws it).
// The engine names the user's slot holds, listeners, watches and queue place
// "user" (domain/user_regs.rs `USER`): a word no agent can be given (`valid_name`
// reserves it), so it is never an agent of the tree.

/** The engine's data name for the user. Not the actor sentinel `@user` other surfaces use. */
export const USER_NAME = 'user'

/** Is this the user's data name? */
export const isUserName = (name: string | null | undefined): boolean => name === USER_NAME
