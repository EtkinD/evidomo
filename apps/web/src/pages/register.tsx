import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useTranslations } from 'use-intl';
import { AuthCard } from '../components/AuthCard';
import { AuthForm } from '../components/AuthForm';
import { useRegister } from '../lib/auth';
import { safeNextPath, withNext } from '../lib/next-path';
import { getStaticProps } from '../lib/i18n-server';
import type { NextPageWithAuth } from '../lib/page-auth';

export { getStaticProps };

const RegisterPage: NextPageWithAuth = () => {
  const t = useTranslations('auth');
  const router = useRouter();
  const next = safeNextPath(router.query['next']);
  const register = useRegister();

  return (
    <>
      <Head>
        <title>{t('register.pageTitle')}</title>
      </Head>
      <AuthCard
        title={t('register.title')}
        description={t('register.description')}
        footer={
          <>
            {t('register.haveAccount')}{' '}
            <Link
              href={withNext('/login', next)}
              className="link inline-flex min-h-11 items-center"
            >
              {t('register.logInLink')}
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
