import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { AuthCard } from '../components/AuthCard';
import { AuthForm } from '../components/AuthForm';
import { useLogin } from '../lib/auth';
import { safeNextPath, withNext } from '../lib/next-path';
import type { NextPageWithAuth } from '../lib/page-auth';

const LoginPage: NextPageWithAuth = () => {
  const router = useRouter();
  const next = safeNextPath(router.query['next']);
  const login = useLogin();

  return (
    <>
      <Head>
        <title>Log in — Evidomo</title>
      </Head>
      <AuthCard
        title="Log in"
        description="Back to your listing packs."
        footer={
          <>
            No account yet?{' '}
            <Link
              href={withNext('/register', next)}
              className="link inline-flex min-h-11 items-center"
            >
              Create an account
            </Link>
          </>
        }
      >
        <AuthForm mode="login" mutation={login} loginHref={withNext('/login', next)} />
      </AuthCard>
    </>
  );
};

LoginPage.auth = 'guest';

export default LoginPage;
