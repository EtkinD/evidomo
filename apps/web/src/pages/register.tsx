import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { AuthCard } from '../components/AuthCard';
import { AuthForm } from '../components/AuthForm';
import { useRegister } from '../lib/auth';
import { safeNextPath, withNext } from '../lib/next-path';
import type { NextPageWithAuth } from '../lib/page-auth';

const RegisterPage: NextPageWithAuth = () => {
  const router = useRouter();
  const next = safeNextPath(router.query['next']);
  const register = useRegister();

  return (
    <>
      <Head>
        <title>Create account — Evidomo</title>
      </Head>
      <AuthCard
        title="Create your account"
        footer={
          <>
            Already have an account?{' '}
            <Link href={withNext('/login', next)} className="link">
              Log in
            </Link>
          </>
        }
      >
        <AuthForm mode="register" mutation={register} loginHref={withNext('/login', next)} />
      </AuthCard>
    </>
  );
};

RegisterPage.auth = 'guest';

export default RegisterPage;
