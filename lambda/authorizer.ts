import { createRemoteJWKSet, jwtVerify } from 'jose';

const CLERK_ISSUER = process.env.CLERK_ISSUER?.trim().replace(/\/$/, '');

// Module scope so the JWKS is fetched once per container and reused across invocations.
const jwks = CLERK_ISSUER
  ? createRemoteJWKSet(new URL(`${CLERK_ISSUER}/.well-known/jwks.json`))
  : null;

interface TokenAuthorizerEvent {
  type: 'TOKEN';
  authorizationToken?: string;
  methodArn: string;
}

/**
 * Policies are cached per token (300s), so the Allow must cover every method on the
 * stage; scoping it to event.methodArn would make a cached token 403 on the other route.
 */
function stageWildcardArn(methodArn: string): string {
  // arn:aws:execute-api:{region}:{account}:{apiId}/{stage}/{verb}/{resource...}
  const [apiArn, stage] = methodArn.split('/');
  return `${apiArn}/${stage}/*/*`;
}

export const handler = async (event: TokenAuthorizerEvent) => {
  if (!jwks || !CLERK_ISSUER) {
    console.error('CLERK_ISSUER environment variable is not set');
    throw new Error('Unauthorized');
  }

  const match = event.authorizationToken?.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new Error('Unauthorized');
  }

  try {
    const { payload } = await jwtVerify(match[1].trim(), jwks, {
      issuer: CLERK_ISSUER,
    });
    if (!payload.sub) {
      throw new Error('Token has no sub claim');
    }

    return {
      principalId: payload.sub,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'execute-api:Invoke',
            Effect: 'Allow',
            Resource: stageWildcardArn(event.methodArn),
          },
        ],
      },
      context: {
        userId: payload.sub,
      },
    };
  } catch (err) {
    console.warn('JWT verification failed', { error: String(err) });
    throw new Error('Unauthorized');
  }
};
