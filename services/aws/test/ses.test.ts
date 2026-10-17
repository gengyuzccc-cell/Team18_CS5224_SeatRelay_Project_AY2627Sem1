import { MessageRejected, SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, test } from 'vitest';
import { SesEmailSender, classifySesError } from '../src/adapters/ses';

const ses = mockClient(SESClient);

beforeEach(() => {
  ses.reset();
});

describe('classifySesError', () => {
  test('MessageRejected and other "will never work" client errors are permanent', () => {
    expect(classifySesError(new MessageRejected({ $metadata: {}, message: 'not verified' }))).toBe(
      'permanent',
    );
    expect(classifySesError({ name: 'MailFromDomainNotVerifiedException' })).toBe('permanent');
    expect(classifySesError({ name: 'ValidationError' })).toBe('permanent');
    expect(classifySesError({ name: 'SomethingElse', $fault: 'client' })).toBe('permanent');
  });

  test('throttling, 5xx, network and unknown errors are transient (retried by the stream)', () => {
    expect(classifySesError({ name: 'Throttling' })).toBe('transient');
    expect(classifySesError({ name: 'TooManyRequestsException' })).toBe('transient');
    expect(classifySesError({ name: 'ServiceUnavailable' })).toBe('transient');
    expect(classifySesError({ name: 'TimeoutError' })).toBe('transient');
    expect(classifySesError({ name: 'Weird', $fault: 'server' })).toBe('transient');
    expect(classifySesError({ name: 'Weird', $retryable: {} })).toBe('transient');
    expect(classifySesError(new Error('ECONNRESET'))).toBe('transient');
    expect(classifySesError('string')).toBe('transient');
  });
});

describe('SesEmailSender', () => {
  const message = {
    to: 'bob@example.com',
    subject: '[SeatRelay] Seat offered: Morning',
    text: 'plain',
    html: '<p>html</p>',
  };

  test('SendEmail with the verified sender, text and HTML parts', async () => {
    ses.on(SendEmailCommand).resolves({ MessageId: 'ses-1' });
    const sender = new SesEmailSender(new SESClient({}), 'team@example.com');
    await expect(sender.send(message)).resolves.toEqual({ ok: true, messageId: 'ses-1' });
    expect(ses.commandCalls(SendEmailCommand)[0]!.args[0].input).toEqual({
      Source: 'team@example.com',
      Destination: { ToAddresses: ['bob@example.com'] },
      Message: {
        Subject: { Data: message.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: 'plain', Charset: 'UTF-8' },
          Html: { Data: '<p>html</p>', Charset: 'UTF-8' },
        },
      },
    });
  });

  test('a permanent rejection is returned, a transient one is thrown', async () => {
    ses
      .on(SendEmailCommand)
      .rejectsOnce(
        new MessageRejected({ $metadata: {}, message: 'Email address is not verified.' }),
      )
      .rejectsOnce(
        Object.assign(new Error('Maximum sending rate exceeded.'), { name: 'Throttling' }),
      );
    const sender = new SesEmailSender(new SESClient({}), 'team@example.com');
    await expect(sender.send(message)).resolves.toEqual({
      ok: false,
      error: 'MessageRejected: Email address is not verified.',
    });
    await expect(sender.send(message)).rejects.toThrow('Maximum sending rate exceeded.');
  });
});
