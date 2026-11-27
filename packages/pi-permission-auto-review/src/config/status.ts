export type PermissionObservation = 'registered' | 'asked' | 'uncaptured-ask'
export type AuthorizerStatus = 'invalid-config' | 'unregistered' | PermissionObservation

interface StatusText {
  footer: string
  report: string
  warning: boolean
}

export const AUTHORIZER_STATUS: Readonly<Record<AuthorizerStatus, StatusText>> = {
  'invalid-config': {
    footer: 'auto-review inactive: invalid config',
    report: 'Reviewer configuration is unavailable.',
    warning: true,
  },
  unregistered: {
    footer: 'auto-review unregistered',
    report: 'The reviewer is not registered with the permission service.',
    warning: true,
  },
  registered: {
    footer: 'auto-review registered · no asks observed · check authorizerChain',
    report:
      'The reviewer is registered. No permission asks have reached it in this session. To review permission asks, add auto-review to authorizerChain.',
    warning: false,
  },
  asked: {
    footer: 'auto-review selected · ask observed',
    report: 'The permission system selected the reviewer for an ask in this session.',
    warning: false,
  },
  'uncaptured-ask': {
    footer: 'auto-review selected · ask arrived before capture · load auto-review first',
    report:
      'A permission ask reached the reviewer without a tool capture. Load auto-review before pi-permission-system.',
    warning: true,
  },
}
