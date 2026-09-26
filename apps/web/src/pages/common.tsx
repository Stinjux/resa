import { useEffect, useState } from 'react';
import { get, type Club, type Course, type User } from '../api';

export function useClubs(user: User | null, roles?: string[]) {
  const [clubs, setClubs] = useState<Club[]>([]);
  useEffect(() => {
    get<{ clubs: Club[] }>('/api/clubs').then((r) => {
      if (!user || !roles) return setClubs(r.clubs);
      const mine = user.roles.filter((x) => roles.includes(x.role));
      const all = mine.some((x) => x.role === 'org_admin');
      setClubs(all ? r.clubs : r.clubs.filter((c) => mine.some((x) => x.clubId === c.id)));
    });
  }, [user]);
  return clubs;
}

export function useCourses(clubId: string | null) {
  const [courses, setCourses] = useState<Course[]>([]);
  useEffect(() => {
    if (!clubId) return setCourses([]);
    get<{ courses: Course[] }>(`/api/clubs/${clubId}/courses`).then((r) => setCourses(r.courses));
  }, [clubId]);
  return courses;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="alert" role="alert">{error}</div> : null;
}
