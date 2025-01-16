/* eslint-disable no-console */
import { type Boom } from '@hapi/boom'
import makeWASocket, {
  DisconnectReason,
  type GroupMetadata,
  type proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys'

let sock: ReturnType<typeof makeWASocket>

function getGroupSubjectFromMessage(message: proto.IWebMessageInfo) {
  const chatDisplayName =
    message.pushName ??
    message.message?.chat?.displayName ??
    message.key.participant ??
    message.key.remoteJid ??
    ''

  const redirectGroupPrefix = '🔄 '

  return `${redirectGroupPrefix} ${chatDisplayName}`
}

async function getGroupFromSubject(subject: string): Promise<GroupMetadata | null> {
  const result = await sock.groupFetchAllParticipating()
  const groups = Object.values(result)

  return groups.find((group) => group.subject === subject) ?? null
}

async function createGroup(
  sourceChatParticipantId: string,
  groupName: string,
): Promise<GroupMetadata> {
  const group = await sock.groupCreate(groupName, [sourceChatParticipantId])

  return group
}

async function redirectMessage(message: proto.IWebMessageInfo) {
  const groupSubject = getGroupSubjectFromMessage(message)
  let redirectGroup = await getGroupFromSubject(groupSubject)

  console.log('existing group', redirectGroup)

  if (!redirectGroup) {
    redirectGroup = await createGroup(message.key.remoteJid ?? '', groupSubject)
  }

  console.log('new group', redirectGroup)

  await sock.sendMessage(redirectGroup.id, { forward: message })
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys')

  sock = makeWASocket({
    // can provide additional config here
    auth: state,
    printQRInTerminal: true,
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update

    if (connection === 'close') {
      const shouldReconnect =
        ((lastDisconnect?.error as Boom).output.statusCode as DisconnectReason) !==
        DisconnectReason.loggedOut

      console.log(
        'connection closed due to ',
        lastDisconnect?.error,
        ', reconnecting ',
        shouldReconnect,
      )

      // reconnect if not logged out
      if (shouldReconnect) {
        await connectToWhatsApp()
      }
    } else if (connection === 'open') {
      console.log('opened connection')
    }
  })
  sock.ev.on('messages.upsert', (event) => {
    console.log(event.messages)

    for (const message of event.messages) {
      if (message.key.remoteJid && !message.key.fromMe) {
        redirectMessage(message)
      }
    }
  })

  // to storage creds (session info) when it updates
  sock.ev.on('creds.update', saveCreds)
}

// run in main file
connectToWhatsApp()
