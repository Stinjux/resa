// Envoi d'e-mails. SMTP standard : fonctionne avec tout fournisseur (Brevo,
// OVH, Google Workspace, Amazon SES, Mailjet…) via SMTP_URL, par exemple
// smtps://utilisateur:motdepasse@smtp.fournisseur.com:465
// Sans SMTP_URL : mode « journal », rien n'est envoyé (visible dans Resa).

import nodemailer from 'nodemailer';

export interface EmailMessage {
  from: string;
  replyTo?: string | null;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Array<{ filename: string; content: string; contentType: string }>;
}

export interface EmailSender {
  readonly mode: 'smtp' | 'log';
  send(message: EmailMessage): Promise<{ id: string | null }>;
}

export class LogEmailSender implements EmailSender {
  readonly mode = 'log' as const;
  async send() {
    return { id: null };
  }
}

export function smtpSender(url: string): EmailSender {
  const transport = nodemailer.createTransport(url);
  return {
    mode: 'smtp',
    async send(m) {
      const info = await transport.sendMail({ from: m.from, replyTo: m.replyTo ?? undefined, to: m.to, subject: m.subject, text: m.text, html: m.html,
        attachments: m.attachments });
      return { id: info.messageId ?? null };
    },
  };
}

export function emailSenderFromEnv(env: NodeJS.ProcessEnv = process.env): EmailSender {
  return env.SMTP_URL ? smtpSender(env.SMTP_URL) : new LogEmailSender();
}

/** Adresse d'expédition (domaine vérifié chez le fournisseur). */
export const emailFrom = (clubName: string, env: NodeJS.ProcessEnv = process.env) =>
  `"${clubName.replace(/"/g, '')}" <${env.EMAIL_FROM ?? 'reservations@resa.local'}>`;
