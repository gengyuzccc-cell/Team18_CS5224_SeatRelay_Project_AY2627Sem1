import { SendEmailCommand, type SESClient } from '@aws-sdk/client-ses';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Transient failures are thrown (the record is retried); permanent ones are returned. */
export type EmailSendResult = { ok: true; messageId?: string } | { ok: false; error: string };

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailSendResult>;
}

/** Errors SES will keep returning for this message: record FAILED and move on (plan §2.4). */
const PERMANENT_ERRORS = new Set([
  'MessageRejected', // sandbox: unverified address, or content rejected
  'MailFromDomainNotVerifiedException',
  'ConfigurationSetDoesNotExistException',
  'ConfigurationSetSendingPausedException',
  'AccountSendingPausedException',
  'InvalidParameterValue',
  'ValidationError',
  'ValidationException',
]);

const TRANSIENT_PATTERN =
  /Throttl|TooManyRequests|ServiceUnavailable|InternalFailure|Timeout|LimitExceeded|Networking|ECONN|EAI_AGAIN/i;

export type SesErrorKind = 'permanent' | 'transient';

/**
 * `MessageRejected` and the other 4xx "will never work" errors are permanent. Throttling,
 * 5xx and network errors are transient. Unknown errors are treated as transient so that an
 * e-mail is never silently dropped (the stream retries, then the DLQ alarm fires).
 */
export function classifySesError(error: unknown): SesErrorKind {
  const name =
    typeof error === 'object' && error !== null
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  if (PERMANENT_ERRORS.has(name)) {
    return 'permanent';
  }
  if (TRANSIENT_PATTERN.test(name)) {
    return 'transient';
  }
  const fault = (error as { $fault?: string }).$fault;
  const retryable = (error as { $retryable?: unknown }).$retryable;
  if (fault === 'server' || retryable !== undefined) {
    return 'transient';
  }
  return fault === 'client' ? 'permanent' : 'transient';
}

export class SesEmailSender implements EmailSender {
  constructor(
    private readonly ses: SESClient,
    private readonly sender: string,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    try {
      const output = await this.ses.send(
        new SendEmailCommand({
          Source: this.sender,
          Destination: { ToAddresses: [message.to] },
          Message: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: message.text, Charset: 'UTF-8' },
              Html: { Data: message.html, Charset: 'UTF-8' },
            },
          },
        }),
      );
      return output.MessageId === undefined
        ? { ok: true }
        : { ok: true, messageId: output.MessageId };
    } catch (error) {
      if (classifySesError(error) === 'permanent') {
        const name = (error as { name?: string }).name ?? 'Error';
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, error: `${name}: ${detail}` };
      }
      throw error;
    }
  }
}
