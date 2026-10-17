import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertAwsCredentials,
  CREDENTIALS_HINT,
  getStackOutputs,
  requireOutput,
} from '../src/lib/aws';
import { CliError } from '../src/lib/cli';
import { resolveCognitoIds } from '../src/lib/cognito';
import { resolveTarget } from '../src/lib/targets';

const cfn = mockClient(CloudFormationClient);

afterEach(() => {
  cfn.reset();
  delete process.env.TARGET_API;
});

describe('stack outputs', () => {
  it('reads Outputs as a map and requires keys', async () => {
    cfn.on(DescribeStacksCommand, { StackName: 'seatrelay-auth' }).resolves({
      Stacks: [
        {
          StackName: 'seatrelay-auth',
          CreationTime: new Date(),
          StackStatus: 'CREATE_COMPLETE',
          Outputs: [
            { OutputKey: 'UserPoolId', OutputValue: 'ap-southeast-1_abc' },
            { OutputKey: 'ToolingClientId', OutputValue: 'tool123' },
          ],
        },
      ],
    });
    const outputs = await getStackOutputs(
      'seatrelay-auth',
      new CloudFormationClient({ region: 'ap-southeast-1' }),
    );
    expect(outputs).toEqual({ UserPoolId: 'ap-southeast-1_abc', ToolingClientId: 'tool123' });
    expect(requireOutput(outputs, 'UserPoolId', 'seatrelay-auth')).toBe('ap-southeast-1_abc');
    expect(() => requireOutput(outputs, 'Nope', 'seatrelay-auth')).toThrow(CliError);
  });

  it('turns a missing stack into a CliError with a hint', async () => {
    cfn
      .on(DescribeStacksCommand)
      .rejects(new Error('Stack with id seatrelay-app-dev does not exist'));
    await expect(
      getStackOutputs('seatrelay-app-dev', new CloudFormationClient({ region: 'ap-southeast-1' })),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('does not exist'),
    });
  });

  it('resolveCognitoIds prefers flags and otherwise reads the auth stack', async () => {
    cfn.on(DescribeStacksCommand, { StackName: 'seatrelay-auth' }).resolves({
      Stacks: [
        {
          StackName: 'seatrelay-auth',
          CreationTime: new Date(),
          StackStatus: 'CREATE_COMPLETE',
          Outputs: [
            { OutputKey: 'UserPoolId', OutputValue: 'pool' },
            { OutputKey: 'ToolingClientId', OutputValue: 'client' },
          ],
        },
      ],
    });
    const client = new CloudFormationClient({ region: 'ap-southeast-1' });
    expect(
      await resolveCognitoIds({ userPoolId: 'p', clientId: 'c', region: 'ap-southeast-1' }),
    ).toMatchObject({
      userPoolId: 'p',
      clientId: 'c',
      source: 'flags',
    });
    expect(await resolveCognitoIds({ cfnClient: client, region: 'ap-southeast-1' })).toMatchObject({
      userPoolId: 'pool',
      clientId: 'client',
      source: 'stack',
    });
  });

  it('resolveTarget: local default, env/flag override, dev from the app stack', async () => {
    expect(await resolveTarget({ target: 'local' })).toMatchObject({
      apiBase: 'http://localhost:3000',
      apiSource: 'default',
    });
    expect(await resolveTarget({ target: 'dev', api: 'https://x.example/' })).toMatchObject({
      apiBase: 'https://x.example',
      apiSource: 'flag',
    });
    process.env.TARGET_API = 'https://env.example';
    expect(await resolveTarget({ target: 'dev' })).toMatchObject({
      apiBase: 'https://env.example',
      apiSource: 'env',
    });
    delete process.env.TARGET_API;
    cfn.on(DescribeStacksCommand, { StackName: 'seatrelay-app-dev' }).resolves({
      Stacks: [
        {
          StackName: 'seatrelay-app-dev',
          CreationTime: new Date(),
          StackStatus: 'CREATE_COMPLETE',
          Outputs: [
            {
              OutputKey: 'ApiUrl',
              OutputValue: 'https://abc.execute-api.ap-southeast-1.amazonaws.com',
            },
          ],
        },
      ],
    });
    expect(
      await resolveTarget({
        target: 'dev',
        cfnClient: new CloudFormationClient({ region: 'ap-southeast-1' }),
      }),
    ).toMatchObject({
      apiBase: 'https://abc.execute-api.ap-southeast-1.amazonaws.com',
      apiSource: 'stack',
      stage: 'dev',
    });
  });

  it('fails fast with a clear message when no credentials resolve', async () => {
    await expect(
      resolveTarget({
        target: 'dev',
        credentialsCheck: async () => {
          throw new CliError(CREDENTIALS_HINT, { hint: 'Pass --api' });
        },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('No AWS credentials') });

    const rejecting = {
      config: {
        credentials: async () => {
          throw new Error('Could not load credentials from any providers');
        },
      },
    };
    await expect(assertAwsCredentials(rejecting)).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('No AWS credentials'),
    });
    const resolving = {
      config: { credentials: async () => ({ accessKeyId: 'AKIA', secretAccessKey: 's' }) },
    };
    await expect(assertAwsCredentials(resolving)).resolves.toBeUndefined();
    await expect(assertAwsCredentials({ config: {} })).rejects.toBeInstanceOf(CliError);
  });
});
