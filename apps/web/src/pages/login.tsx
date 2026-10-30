import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useTranslations } from 'use-intl';
import { AuthCard } from '../components/AuthCard';
import { AuthForm } from '../components/AuthForm';
import { useLogin } from '../lib/auth';
import { safeNextPath, withNext } from '../lib/next-path';
import { getStaticProps } from '../lib/i18n-server';
import type { NextPageWithAuth } from '../lib/page-auth';

export { getStaticProps };

const LoginPage: NextPageWithAuth = () => {
  const t = useTranslations('auth');
  const router = useRouter();
  const next = safeNextPath(router.query['next']);
  const login = useLogin();

  return (
    <>
      <Head>
        <title>{t('login.pageTitle')}</title>
      </Head>
      <AuthCard
        title={t('login.title')}
        description={t('login.description')}
        footer={
          <>
            {t('login.noAccount')}{' '}
            <Link
              href={withNext('/register', next)}
              className="link inline-flex min-h-11 items-center"
            >
              {t('login.createAccountLink')}
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
